/**
 * 插件系统 - 主进程宿主（initPluginManager）。
 *
 * 职责：
 *  1. 初始化插件目录、HookBus、PatchManager、PluginManager。
 *  2. 注册管理类 IPC（供 renderer UI 调用：列表/安装/卸载/更新/启用/禁用）。
 *  3. 加载已启用的“主进程插件”。
 *  4. 在 global.lx.plugins 上暴露宿主 API（hooks/patch/管理），供源码扩展点与主进程插件使用。
 *
 * 对源代码的侵入仅 2 行（均在 src/main/index.ts，带 `Plugin Manager` 标记）：
 *   import { initPluginManager } from '../plugins/main'
 *   void initPluginManager().catch(...)
 * 插件目录基于 app.getPath('userData')，因此必须在上游 setUserDataPath() 之后调用（init 阶段天然满足）。
 */
import { app, dialog } from 'electron'
import { existsSync, mkdirSync, readFileSync, writeFileSync, statSync } from 'fs'
import { basename, join } from 'path'
import { PluginManager } from './manager'
import { PatchManager } from './patch'
import { HookBus } from './hookBus'
import { createPluginApi } from './host'
import type { HostContext } from './host'
import { mainHandle } from '@common/mainIpc'
import { openDirInExplorer } from '@common/utils/electron'
import { PLUGIN_IPC } from './ipc'
import type { PluginRuntimeState } from './ipc'
import { getAppVersion } from './manifest'
import { MAX_PLUGIN_FILE_SIZE } from './format'
import type { PluginInfo, PluginOperationResult } from './types'

let manager: PluginManager | null = null
let pluginsDir = ''
const mainHooks = new HookBus()
const mainPatch = new PatchManager()

// 主进程插件私有数据（pluginsDir/<id>/data.json）
function readData(pluginId: string, key: string, def?: any): any {
  try {
    const file = join(pluginsDir, pluginId, 'data.json')
    if (!existsSync(file)) return def
    const json = JSON.parse(readFileSync(file, 'utf-8'))
    return key in json ? json[key] : def
  } catch {
    return def
  }
}
function writeData(pluginId: string, key: string, value: any): void {
  try {
    const dir = join(pluginsDir, pluginId)
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    const file = join(dir, 'data.json')
    const json = existsSync(file) ? JSON.parse(readFileSync(file, 'utf-8')) : {}
    json[key] = value
    writeFileSync(file, JSON.stringify(json, null, 2), 'utf-8')
  } catch (err) {
    console.error(`[plugin] 写入数据失败 ${pluginId}.${key}:`, err)
  }
}

const host: HostContext = {
  platform: 'main',
  hooks: mainHooks,
  patchManager: mainPatch,
  // 用 getter 延迟取用，避免模块加载时 global.lx 尚未初始化
  get app() {
    return global.lx
  },
  logger: (id: string) => ({
    info: (...args: any[]) => { console.log(`[plugin:${id}]`, ...args) },
    warn: (...args: any[]) => { console.warn(`[plugin:${id}]`, ...args) },
    error: (...args: any[]) => { console.error(`[plugin:${id}]`, ...args) },
  }),
  getData: readData,
  setData: writeData,
  // 插件配置固定落在 <插件目录>/config.json；manager 在 initPluginManager 中创建，
  // 这里用闭包延迟取用（调用时必然已初始化）。
  getConfig: (pluginId: string) => manager!.getConfig(pluginId),
  setConfig: (pluginId: string, patch: Record<string, any>) => { manager!.setConfig(pluginId, patch) },
}

/** 在 init() 内调用：初始化插件管理并加载主进程插件（必须先于窗口创建完成同步部分） */
export async function initPluginManager(): Promise<void> {
  pluginsDir = join(app.getPath('userData'), 'plugins')
  if (!existsSync(pluginsDir)) mkdirSync(pluginsDir, { recursive: true })

  manager = new PluginManager(pluginsDir, host)
  registerIpc()

  // 暴露宿主 API 给源码扩展点与主进程插件
  const hostApi = createPluginApi(host, '_host_', getAppVersion(), pluginsDir) as any
  hostApi.manager = {
    list: (): PluginInfo[] => manager!.list(),
    install: async(dir: string) => manager!.install(dir),
    installContents: async(fileName: string, content: string) => manager!.installContents(fileName, content),
    updateContents: async(id: string, fileName: string, content: string) => manager!.updateContents(id, fileName, content),
    uninstall: async(id: string) => manager!.uninstall(id),
    update: async(id: string, dir: string) => manager!.update(id, dir),
    enable: async(id: string) => manager!.enable(id),
    disable: async(id: string) => manager!.disable(id),
    getInfo: (id: string) => manager!.getInfo(id),
  }
  ;(global.lx as any).plugins = hostApi

  // 加载已启用的主进程插件
  await manager.loadEnabledMainPlugins()
}

function registerIpc(): void {
  const m = () => manager!
  mainHandle(PLUGIN_IPC.list, async() => m().list())
  mainHandle(PLUGIN_IPC.rendererList, async() => m().getLoadableRendererPlugins())
  mainHandle(PLUGIN_IPC.readEntry, async({ params }: { params: { id: string } }) => {
    try {
      return { success: true, code: m().readEntryCode(params.id) }
    } catch (err) {
      return { success: false, message: (err as Error).message }
    }
  })

  // 文件夹形态（本地开发）
  mainHandle(PLUGIN_IPC.installPick, async() => {
    const dir = await pickDir()
    if (!dir) return cancelled()
    return m().install(dir)
  })
  mainHandle(PLUGIN_IPC.installPath, async({ params }: { params: { dir: string } }) => m().install(params.dir))
  mainHandle(PLUGIN_IPC.updatePick, async({ params }: { params: { id: string } }) => {
    const dir = await pickDir()
    if (!dir) return cancelled()
    return m().update(params.id, dir)
  })
  mainHandle(PLUGIN_IPC.updatePath, async({ params }: { params: { id: string, dir: string } }) => m().update(params.id, params.dir))

  // 单文件形态（上传直接安装 / 更新）
  mainHandle(PLUGIN_IPC.installFilePick, async() => {
    const file = await pickPluginFile()
    if (!file) return cancelled()
    return installFromFile(file)
  })
  mainHandle(PLUGIN_IPC.installContent, async({ params }: { params: { fileName: string, content: string } }) => {
    return guardUpload(params, async() => m().installContents(params.fileName, params.content))
  })
  mainHandle(PLUGIN_IPC.updateFilePick, async({ params }: { params: { id: string } }) => {
    const file = await pickPluginFile()
    if (!file) return cancelled()
    try {
      return await m().updateContents(params.id, basename(file), readPluginFile(file))
    } catch (err) {
      return failResult((err as Error).message)
    }
  })
  mainHandle(PLUGIN_IPC.updateContent, async({ params }: { params: { id: string, fileName: string, content: string } }) => {
    return guardUpload(params, async() => m().updateContents(params.id, params.fileName, params.content))
  })

  mainHandle(PLUGIN_IPC.uninstall, async({ params }: { params: { id: string } }) => m().uninstall(params.id))
  mainHandle(PLUGIN_IPC.enable, async({ params }: { params: { id: string } }) => m().enable(params.id))
  mainHandle(PLUGIN_IPC.disable, async({ params }: { params: { id: string } }) => m().disable(params.id))
  mainHandle(PLUGIN_IPC.openDir, async({ params }: { params: { id: string } }) => {
    const dir = join(pluginsDir, params.id)
    openDirInExplorer(dir)
    const result: PluginOperationResult = { success: true }
    return result
  })
  // renderer 宿主上报加载结果，使列表能如实显示 renderer 端插件的状态
  mainHandle(PLUGIN_IPC.reportState, async({ params }: { params: { id: string, state: PluginRuntimeState, error?: string } }) => {
    m().reportRuntimeState(params.id, params.state, params.error)
  })

  // 插件配置读写（配置保存在 <插件目录>/config.json，各插件彼此隔离）
  mainHandle(PLUGIN_IPC.configRead, async({ params }: { params: { id: string } }) => {
    return m().getConfig(params.id)
  })
  mainHandle(PLUGIN_IPC.configWrite, async({ params }: { params: { id: string, patch: Record<string, any> } }) => {
    return m().setConfig(params.id, params.patch)
  })
}

/** 上传内容体积保护 + 统一错误转结果 */
async function guardUpload(
  params: { content?: string },
  run: () => Promise<PluginOperationResult>,
): Promise<PluginOperationResult> {
  const content = params?.content
  if (typeof content !== 'string' || !content) return failResult('插件文件内容为空')
  if (content.length > MAX_PLUGIN_FILE_SIZE) return failResult('插件文件过大（上限 8 MB）')
  try {
    return await run()
  } catch (err) {
    return failResult((err as Error).message)
  }
}

function readPluginFile(filePath: string): string {
  const stat = statSync(filePath)
  if (!stat.isFile()) throw new Error('请选择插件文件（.lxplugin）')
  if (stat.size > MAX_PLUGIN_FILE_SIZE) throw new Error('插件文件过大（上限 8 MB）')
  const content = readFileSync(filePath, 'utf-8')
  if (!content.trim()) throw new Error('插件文件内容为空')
  return content
}

async function installFromFile(filePath: string): Promise<PluginOperationResult> {
  try {
    return await manager!.installContents(basename(filePath), readPluginFile(filePath))
  } catch (err) {
    return failResult((err as Error).message)
  }
}

async function pickDir(): Promise<string | null> {
  const res = await dialog.showOpenDialog({ properties: ['openDirectory'] })
  if (res.canceled || !res.filePaths.length) return null
  return res.filePaths[0]
}

async function pickPluginFile(): Promise<string | null> {
  const res = await dialog.showOpenDialog({
    properties: ['openFile'],
    filters: [
      { name: 'LX Music 插件', extensions: ['lxplugin', 'js', 'cjs'] },
      { name: '所有文件', extensions: ['*'] },
    ],
  })
  if (res.canceled || !res.filePaths.length) return null
  return res.filePaths[0]
}

function cancelled(): PluginOperationResult {
  return { success: false, message: '已取消' }
}
function failResult(message: string): PluginOperationResult {
  return { success: false, message }
}
