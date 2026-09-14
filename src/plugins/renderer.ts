/**
 * 插件系统 - renderer 宿主（initUserPlugins）。
 *
 * 职责：
 *  1. 通过 IPC 调用主进程管理器完成“安装/卸载/更新/启用/禁用/列表”。
 *  2. 加载“renderer 端插件”：从主进程取回入口源码后，用 loader 在 CommonJS 语义下求值并执行 setup。
 *  3. 在 window.lx.plugins 暴露宿主 API（hooks/patch/registerMusicSource/管理/load/unload）。
 *  4. 维护 window.lx.pluginMusicSources（Map），musicSdk 会将其合入音乐源。
 *  5. 暴露 window.lx.musicSdk，便于插件以 api.patch 覆盖原搜索/列表等功能。
 *
 * renderer 侧对源代码的侵入共四处（均带 `Plugin Manager` 标记）：
 *  - src/renderer/main.ts 中调用 initUserPlugins(app)
 *  - src/renderer/utils/musicSdk/index.js 中合并 window.lx.pluginMusicSources
 *  - src/renderer/utils/request.js 的 getRequestAgent 中查询 window.lx.pluginNetAgent（插件接管代理 agent）
 *  - src/renderer/views/Setting/index.vue 中挂上「插件管理」标签页（src/plugins/ui/SettingPlugins.vue）
 */
import { ipcRenderer } from 'electron'
import musicSdk from '@renderer/utils/musicSdk'
import { HookBus } from './hookBus'
import { PatchManager } from './patch'
import { createPluginApi, getPatchRecords, disposeApi } from './host'
import type { HostContext } from './host'
import { evaluatePluginModule } from './loader'
import type { ModuleRequire } from './loader'
import { PLUGIN_IPC } from './ipc'
import { parsePluginFile } from './format'
import { getAppVersion } from './validate'
import type { PluginApi, PluginManifest, PluginModule, PluginOperationResult, PluginInfo } from './types'

let rendererHooks: HookBus
let rendererPatch: PatchManager
let rendererHostCtx: HostContext
// 已注册的音乐源：id -> { name, module }
const musicSources = new Map<string, { name: string, module: any }>()
// 已加载的 renderer 插件
const loadedRenderers = new Map<string, { module: PluginModule, api: PluginApi }>()

const APP_VERSION = getAppVersion()

/**
 * 自带的 IPC invoke 封装。
 * 不复用 @common/rendererIpc 的 rendererInvoke：其带参数重载固定返回 void，会丢失返回类型；
 * 在此集中封装即可，无需改动上游公共模块。
 */
async function invoke<V>(name: string, params?: any): Promise<V> {
  return ipcRenderer.invoke(name, params) as Promise<V>
}

interface EntryCodeResult {
  success: boolean
  code?: string
  message?: string
}

/**
 * 把 renderer 端插件的加载结果回传给主进程。
 * 主进程只加载 main 端插件，不知道 renderer 端是否真的加载成功；
 * 不上报的话，插件管理页就只能靠启用开关猜测状态（历史 bug：renderer 端插件恒显示「已禁用」）。
 * 上报失败本身不应影响插件运行，因此全部异常都被吞掉。
 */
function reportRuntimeState(id: string, state: 'loaded' | 'unloaded' | 'error', error?: string): void {
  void invoke(PLUGIN_IPC.reportState, { id, state, error }).catch(() => {})
}

function makeLogger(id: string): PluginApi['logger'] {
  return {
    info: (...args: any[]) => { console.log(`[plugin:${id}]`, ...args) },
    warn: (...args: any[]) => { console.warn(`[plugin:${id}]`, ...args) },
    error: (...args: any[]) => { console.error(`[plugin:${id}]`, ...args) },
  }
}

function readData(pluginId: string, key: string, def?: any): any {
  try {
    const v = localStorage.getItem(`plugin:${pluginId}:${key}`)
    return v == null ? def : JSON.parse(v)
  } catch {
    return def
  }
}
function writeData(pluginId: string, key: string, value: any): void {
  try {
    localStorage.setItem(`plugin:${pluginId}:${key}`, JSON.stringify(value))
  } catch (err) {
    console.error(`[plugin] 写入数据失败 ${pluginId}.${key}:`, err)
  }
}

function registerMusicSource(id: string, name: string, module: any): void {
  if (!id || typeof id !== 'string') throw new Error('registerMusicSource: id 必须是非空字符串')
  if (Object.prototype.hasOwnProperty.call(musicSdk, id)) {
    console.warn(`[plugin] 音乐源 id 与已有音乐源或既有属性冲突，已忽略：${id}`)
    return
  }
  musicSources.set(id, { name, module })
  // 同时挂到 musicSdk 上：播放地址 / 歌词 / 封面等既有代码路径都通过 musicSdk[source] 取模块
  ;(musicSdk as any)[id] = module
}

function unregisterMusicSource(id: string): void {
  // 只回收本插件系统注册过的 id，内置音乐源不会被删除
  if (!musicSources.has(id)) return
  musicSources.delete(id)
  // 用 Reflect.deleteProperty 而非 delete（动态键删除会触发 @typescript-eslint/no-dynamic-delete）
  Reflect.deleteProperty(musicSdk, id)
}

/** 渲染进程的 require 桥接：主窗口开启了 nodeIntegration，插件可直接 require 依赖 */
function makeRequire(): ModuleRequire {
  const nodeRequire = (window as any).require
  return (id: string) => {
    if (typeof nodeRequire === 'function') return nodeRequire(id)
    throw new Error(`当前环境不支持 require("${id}")，请通过 api 参数访问客户端能力`)
  }
}

/** 加载单个 renderer 端插件 */
export async function loadRendererPlugin(id: string): Promise<void> {
  if (loadedRenderers.has(id)) return
  let list: Array<{ id: string, version: string, main: string }>
  try {
    list = await invoke<Array<{ id: string, version: string, main: string }>>(PLUGIN_IPC.rendererList)
  } catch (err) {
    console.error('[plugin] 获取 renderer 插件清单失败：', err)
    return
  }
  const info = list.find(p => p.id === id)
  // 不在「已启用且兼容」的清单里（例如刚被禁用），状态交给主进程按开关判断
  if (!info) return

  let code: string
  try {
    const res = await invoke<EntryCodeResult>(PLUGIN_IPC.readEntry, { id })
    if (!res.success || !res.code) throw new Error(res.message ?? '读取插件入口失败')
    code = res.code
  } catch (err) {
    console.error(`[plugin] 读取 renderer 插件源码失败 ${id}:`, err)
    reportRuntimeState(id, 'error', `读取插件入口失败：${(err as Error).message}`)
    return
  }

  try {
    const module = evaluatePluginModule({ code, filename: info.main, require: makeRequire() })
    const api = createPluginApi(rendererHostCtx, id, info.version, '') as PluginApi
    if (module.setup) await module.setup(api)
    loadedRenderers.set(id, { module, api })
    rendererHooks.emit('plugin:loaded', { id })
    reportRuntimeState(id, 'loaded')
  } catch (err) {
    console.error(`[plugin] 加载 renderer 插件失败 ${id}:`, err)
    reportRuntimeState(id, 'error', (err as Error).message)
  }
}

/** 卸载单个 renderer 端插件（调用 uninstall 并回退 patch/hooks） */
export async function unloadRendererPlugin(id: string): Promise<void> {
  const rec = loadedRenderers.get(id)
  if (rec) {
    try {
      if (rec.module.uninstall) await rec.module.uninstall()
    } catch (err) {
      console.error(`[plugin] 卸载 renderer 插件失败 ${id}:`, err)
    }
    rendererPatch.unpatchAll(getPatchRecords(rec.api))
    disposeApi(rec.api)
    loadedRenderers.delete(id)
    rendererHooks.emit('plugin:unloaded', { id })
  }
  reportRuntimeState(id, 'unloaded')
}

/** 某 renderer 插件是否已加载 */
export function isRendererPluginLoaded(id: string): boolean {
  return loadedRenderers.has(id)
}

/**
 * 初始化 renderer 插件系统。
 * @param app Vue 应用实例（预留：插件可通过 api.app 拿到，或后续注册 UI 组件）
 */
export async function initUserPlugins(_app?: any): Promise<void> {
  rendererHooks = new HookBus()
  rendererPatch = new PatchManager()
  rendererHostCtx = {
    platform: 'renderer',
    hooks: rendererHooks,
    patchManager: rendererPatch,
    app: (window as any).lx,
    logger: makeLogger,
    getData: readData,
    setData: writeData,
    registerMusicSource,
    unregisterMusicSource,
  }

  // 暴露给源码扩展点与插件
  ;(window as any).lx.pluginMusicSources = musicSources
  ;(window as any).lx.musicSdk = musicSdk
  // 网络代理 agent 接管点（如 SOCKS5 插件）：
  //   插件可设置 window.lx.pluginNetAgent = (url, { host, port }) => agent | undefined
  //   src/renderer/utils/request.js 的 getRequestAgent 会查询它；返回 undefined 表示交还原逻辑。
  //   未安装相关插件时该值为 null，行为与上游完全一致。
  if ((window as any).lx.pluginNetAgent === undefined) (window as any).lx.pluginNetAgent = null

  // 宿主 API（供 UI 与插件使用）
  const hostApi = createPluginApi(rendererHostCtx, '_host_', APP_VERSION, '') as any
  hostApi.manager = {
    list: async() => invoke<PluginInfo[]>(PLUGIN_IPC.list),
    /** 解析单文件插件（纯文本解析，不执行代码），用于上传前预览 */
    inspect: (fileName: string, content: string): { success: boolean, manifest?: PluginManifest, message?: string } => {
      try {
        return { success: true, manifest: parsePluginFile(content).manifest }
      } catch (err) {
        return { success: false, message: (err as Error).message }
      }
    },
    installFilePick: async() => invoke<PluginOperationResult>(PLUGIN_IPC.installFilePick),
    installContent: async(fileName: string, content: string) => invoke<PluginOperationResult>(PLUGIN_IPC.installContent, { fileName, content }),
    installPick: async() => invoke<PluginOperationResult>(PLUGIN_IPC.installPick),
    installPath: async(dir: string) => invoke<PluginOperationResult>(PLUGIN_IPC.installPath, { dir }),
    updateFilePick: async(id: string) => invoke<PluginOperationResult>(PLUGIN_IPC.updateFilePick, { id }),
    updateContent: async(id: string, fileName: string, content: string) => invoke<PluginOperationResult>(PLUGIN_IPC.updateContent, { id, fileName, content }),
    updatePick: async(id: string) => invoke<PluginOperationResult>(PLUGIN_IPC.updatePick, { id }),
    updatePath: async(id: string, dir: string) => invoke<PluginOperationResult>(PLUGIN_IPC.updatePath, { id, dir }),
    uninstall: async(id: string) => invoke<PluginOperationResult>(PLUGIN_IPC.uninstall, { id }),
    enable: async(id: string) => invoke<PluginOperationResult>(PLUGIN_IPC.enable, { id }),
    disable: async(id: string) => invoke<PluginOperationResult>(PLUGIN_IPC.disable, { id }),
    openDir: async(id: string) => invoke<PluginOperationResult>(PLUGIN_IPC.openDir, { id }),
  }
  // renderer 端热加载/卸载（UI 在启用/禁用/安装/卸载后调用）
  hostApi.load = async(id: string) => loadRendererPlugin(id)
  hostApi.unload = async(id: string) => unloadRendererPlugin(id)
  hostApi.isLoaded = (id: string) => isRendererPluginLoaded(id)
  ;(window as any).lx.plugins = hostApi

  // 加载所有已启用的 renderer 端插件
  let list: Array<{ id: string, version: string, main: string }> = []
  try {
    list = await invoke<Array<{ id: string, version: string, main: string }>>(PLUGIN_IPC.rendererList)
  } catch (err) {
    console.error('[plugin] 获取 renderer 插件清单失败：', err)
  }
  for (const p of list) {
    await loadRendererPlugin(p.id)
  }
  rendererHooks.emit('app:ready')
}
