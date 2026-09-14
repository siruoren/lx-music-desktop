/**
 * 插件管理器（运行于主进程）。
 *
 * 负责：扫描/列表、安装、卸载、更新、启用/禁用（持久化 + 加载/卸载 main 端插件）。
 * renderer 端插件在此只做文件管理，其执行由 renderer 宿主取回入口代码后加载。
 *
 * 支持两种插件分发形态：
 *  1. 单文件（推荐）：`.lxplugin`，清单内嵌于文件头横幅注释；插件管理页可“上传直接安装”。
 *  2. 文件夹（兼容）：目录内含 plugin.json，便于本地开发调试。
 *
 * 全部为新增代码，且不依赖任何第三方库（不引入 zip 等解压实现）。
 */
import { existsSync, readdirSync, readFileSync, writeFileSync, mkdirSync, rmSync, statSync, cpSync } from 'fs'
import { basename, join, resolve } from 'path'
import { createRequire } from 'module'
import { EnabledState } from './storage'
import { readManifest, checkCompatibility } from './manifest'
import { compareVersion } from './semver'
import { createPluginApi, getPatchRecords, disposeApi } from './host'
import { evaluatePluginModule } from './loader'
import { parsePluginFile, isPluginFileName, DEFAULT_ENTRY, PLUGIN_FILE_EXT, MAX_PLUGIN_FILE_SIZE } from './format'
import type { HostContext } from './host'
import type {
  PluginInfo,
  PluginManifest,
  PluginModule,
  PluginOperationResult,
} from './types'

interface LoadedPlugin {
  id: string
  manifest: PluginManifest
  module: PluginModule
  api: any
  dir: string
}

/** 单文件插件的清单 + 代码 */
interface ParsedUpload {
  manifest: PluginManifest
  code: string
}

export class PluginManager {
  readonly pluginsDir: string
  private readonly enabled: EnabledState
  private readonly host: HostContext
  private readonly loaded = new Map<string, LoadedPlugin>()

  constructor(pluginsDir: string, host: HostContext) {
    this.pluginsDir = pluginsDir
    if (!existsSync(pluginsDir)) mkdirSync(pluginsDir, { recursive: true })
    this.enabled = new EnabledState(pluginsDir)
    this.host = host
  }

  // ===================== 扫描 / 列表 =====================
  list(): PluginInfo[] {
    if (!existsSync(this.pluginsDir)) return []
    const infos: PluginInfo[] = []
    for (const name of readdirSync(this.pluginsDir)) {
      if (name === 'enabled.json') continue
      const dir = join(this.pluginsDir, name)
      if (!statSync(dir).isDirectory()) continue
      try {
        const manifest = readManifest(dir)
        const enabled = this.enabled.isEnabled(manifest.id)
        let status: PluginInfo['status'] = 'disabled'
        if (enabled) {
          const incompat = checkCompatibility(manifest)
          status = incompat ? 'incompatible' : this.loaded.has(manifest.id) ? 'enabled' : 'disabled'
        }
        infos.push({
          id: manifest.id,
          name: manifest.name,
          version: manifest.version,
          description: manifest.description,
          author: manifest.author,
          homepage: manifest.homepage,
          platforms: manifest.platforms ?? ['renderer'],
          enabled,
          status,
          dir,
        })
      } catch (err) {
        infos.push({
          id: name,
          name,
          version: '',
          platforms: ['renderer'],
          enabled: false,
          status: 'error',
          error: (err as Error).message,
          dir,
        })
      }
    }
    return infos
  }

  getInfo(id: string): PluginInfo | undefined {
    return this.list().find(p => p.id === id)
  }

  /** 启动期加载所有“已启用且兼容”的主进程插件，随后广播 app:ready */
  async loadEnabledMainPlugins(): Promise<void> {
    for (const info of this.list()) {
      if (!info.enabled || info.status === 'incompatible') continue
      if (info.platforms.includes('main')) {
        try {
          await this.loadMain(info.id)
        } catch (err) {
          console.error(`[plugin] 启动加载主进程插件失败 ${info.id}:`, err)
        }
      }
    }
    this.host.hooks.emit('app:ready')
  }

  /**
   * 返回可被 renderer 端加载的插件清单（已启用、兼容、含 renderer 端）。
   * renderer 宿主据此通过 IPC 取回入口代码后加载。
   */
  getLoadableRendererPlugins(): Array<{ id: string, version: string, main: string }> {
    const result: Array<{ id: string, version: string, main: string }> = []
    for (const info of this.list()) {
      if (!info.enabled || info.status === 'incompatible') continue
      if (!info.platforms.includes('renderer')) continue
      try {
        const manifest = readManifest(info.dir)
        result.push({ id: manifest.id, version: manifest.version, main: manifest.main ?? DEFAULT_ENTRY })
      } catch (err) {
        console.error(`[plugin] 读取 renderer 插件清单失败 ${info.id}:`, err)
      }
    }
    return result
  }

  /** 读取某插件入口文件源码（renderer 宿主加载 renderer 端插件时使用） */
  readEntryCode(id: string): string {
    const dir = join(this.pluginsDir, id)
    if (!existsSync(dir)) throw new Error(`插件未安装：${id}`)
    const manifest = readManifest(dir)
    const entry = join(dir, manifest.main ?? DEFAULT_ENTRY)
    if (!existsSync(entry)) throw new Error(`插件入口文件不存在：${manifest.main ?? DEFAULT_ENTRY}`)
    const code = readFileSync(entry, 'utf-8')
    if (Buffer.byteLength(code, 'utf-8') > MAX_PLUGIN_FILE_SIZE) {
      throw new Error('插件入口文件过大（上限 8 MB）')
    }
    return code
  }

  // ===================== 安装（单文件 / 上传） =====================
  /**
   * 从“上传的单文件插件内容”安装。
   * @param fileName 原始文件名（仅用于辅助提示）
   * @param content 文件内容（UTF-8 文本）
   */
  async installContents(fileName: string, content: string): Promise<PluginOperationResult> {
    let parsed: ParsedUpload
    try {
      parsed = this.parseUpload(fileName, content)
    } catch (err) {
      return fail((err as Error).message)
    }
    const { manifest, code } = parsed

    const target = join(this.pluginsDir, manifest.id)
    if (existsSync(target) && readdirSync(target).length > 0) {
      return fail(`插件已安装（${manifest.id}），请使用“更新”功能上传新版本`)
    }

    try {
      this.writePlugin(target, manifest, code)
    } catch (err) {
      return fail(`写入插件文件失败：${(err as Error).message}`)
    }
    this.enabled.setEnabled(manifest.id, true)
    await this.loadMainIfNeeded(manifest)
    return ok(manifest.id, `已安装 ${manifest.name}@${manifest.version}`)
  }

  // ===================== 安装（文件夹，本地开发用） =====================
  /** 从源目录安装插件 */
  async install(fromDir: string): Promise<PluginOperationResult> {
    fromDir = resolve(fromDir)
    if (!existsSync(fromDir)) return fail(`源目录不存在：${fromDir}`)
    let manifest: PluginManifest
    try {
      manifest = readManifest(fromDir)
    } catch (err) {
      return fail((err as Error).message)
    }
    const compat = checkCompatibility(manifest)
    if (compat) return fail(`与当前客户端不兼容：${compat}`)

    const target = join(this.pluginsDir, manifest.id)
    if (existsSync(target) && readdirSync(target).length > 0) {
      return fail(`插件已存在（${manifest.id}），请使用“更新”而非“安装”`)
    }
    try {
      this.copyDir(fromDir, target)
    } catch (err) {
      return fail(`复制文件失败：${(err as Error).message}`)
    }
    this.enabled.setEnabled(manifest.id, true)
    await this.loadMainIfNeeded(manifest)
    return ok(manifest.id, `已安装 ${manifest.name}@${manifest.version}`)
  }

  // ===================== 卸载 =====================
  async uninstall(id: string): Promise<PluginOperationResult> {
    const target = join(this.pluginsDir, id)
    if (!existsSync(target)) return fail(`插件未安装：${id}`)
    await this.unloadMain(id)
    try {
      rmSync(target, { recursive: true, force: true })
    } catch (err) {
      return fail(`删除目录失败：${(err as Error).message}`)
    }
    this.enabled.remove(id)
    return ok(id, `已卸载 ${id}`)
  }

  // ===================== 更新（单文件 / 上传） =====================
  /** 通过上传的单文件插件内容更新已安装插件（要求版本更高） */
  async updateContents(id: string, fileName: string, content: string): Promise<PluginOperationResult> {
    let parsed: ParsedUpload
    try {
      parsed = this.parseUpload(fileName, content)
    } catch (err) {
      return fail((err as Error).message)
    }
    if (parsed.manifest.id !== id) {
      return fail(`插件 id 不匹配：期望 ${id}，实为 ${parsed.manifest.id}`)
    }
    return this.applyUpdate(parsed.manifest, parsed.code)
  }

  // ===================== 更新（文件夹，本地开发用） =====================
  /** 从源目录更新已安装插件（要求版本更高） */
  async update(id: string, fromDir: string): Promise<PluginOperationResult> {
    fromDir = resolve(fromDir)
    if (!existsSync(fromDir)) return fail(`源目录不存在：${fromDir}`)
    let newManifest: PluginManifest
    try {
      newManifest = readManifest(fromDir)
    } catch (err) {
      return fail((err as Error).message)
    }
    if (newManifest.id !== id) return fail(`插件 id 不匹配：期望 ${id}，实为 ${newManifest.id}`)

    const target = join(this.pluginsDir, id)
    if (!existsSync(target)) return fail(`插件未安装：${id}，无法更新`)
    const oldManifest = readManifest(target)
    if (compareVersion(newManifest.version, oldManifest.version) <= 0) {
      return fail(`新版本（${newManifest.version}）未高于已安装版本（${oldManifest.version}）`)
    }
    const compat = checkCompatibility(newManifest)
    if (compat) return fail(`与当前客户端不兼容：${compat}`)

    const oldVersion = oldManifest.version
    await this.unloadMain(id)
    try {
      rmSync(target, { recursive: true, force: true })
      mkdirSync(target, { recursive: true })
      this.copyDir(fromDir, target)
    } catch (err) {
      return fail(`更新文件失败：${(err as Error).message}`)
    }
    this.enabled.setEnabled(id, true)
    await this.loadMainAfterUpdate(newManifest, oldVersion)
    return ok(id, `已更新 ${newManifest.name}@${newManifest.version}`)
  }

  // ===================== 启用 / 禁用 =====================
  async enable(id: string): Promise<PluginOperationResult> {
    const target = join(this.pluginsDir, id)
    if (!existsSync(target)) return fail(`插件未安装：${id}`)
    this.enabled.setEnabled(id, true)
    const manifest = readManifest(target)
    const compat = checkCompatibility(manifest)
    if (compat) return fail(`与当前客户端不兼容：${compat}`)
    if (manifest.platforms?.includes('main')) {
      try { await this.loadMain(id) } catch (err) { console.error(`[plugin] 启用加载失败 ${id}:`, err) }
    }
    return ok(id, `已启用 ${id}`)
  }

  async disable(id: string): Promise<PluginOperationResult> {
    const target = join(this.pluginsDir, id)
    if (!existsSync(target)) return fail(`插件未安装：${id}`)
    this.enabled.setEnabled(id, false)
    await this.unloadMain(id)
    return ok(id, `已禁用 ${id}`)
  }

  // ===================== 内部：安装/更新的公共流程 =====================
  private parseUpload(fileName: string, content: string): ParsedUpload {
    if (fileName && !isPluginFileName(fileName)) {
      throw new Error(`不支持的文件类型：${basename(fileName)}（请上传 ${PLUGIN_FILE_EXT} 单文件插件）`)
    }
    const parsed = parsePluginFile(content)
    const compat = checkCompatibility(parsed.manifest)
    if (compat) throw new Error(`与当前客户端不兼容：${compat}`)
    return parsed
  }

  private writePlugin(target: string, manifest: PluginManifest, code: string): void {
    mkdirSync(target, { recursive: true })
    writeFileSync(join(target, 'plugin.json'), JSON.stringify(manifest, null, 2), 'utf-8')
    writeFileSync(join(target, manifest.main ?? DEFAULT_ENTRY), code, 'utf-8')
  }

  private async applyUpdate(manifest: PluginManifest, code: string): Promise<PluginOperationResult> {
    const id = manifest.id
    const target = join(this.pluginsDir, id)
    if (!existsSync(target)) return fail(`插件未安装：${id}，无法更新`)
    const oldManifest = readManifest(target)
    if (compareVersion(manifest.version, oldManifest.version) <= 0) {
      return fail(`新版本（${manifest.version}）未高于已安装版本（${oldManifest.version}）`)
    }
    const compat = checkCompatibility(manifest)
    if (compat) return fail(`与当前客户端不兼容：${compat}`)

    const oldVersion = oldManifest.version
    await this.unloadMain(id)
    try {
      rmSync(target, { recursive: true, force: true })
      this.writePlugin(target, manifest, code)
    } catch (err) {
      return fail(`更新文件失败：${(err as Error).message}`)
    }
    this.enabled.setEnabled(id, true)
    await this.loadMainAfterUpdate(manifest, oldVersion)
    return ok(id, `已更新 ${manifest.name}@${manifest.version}`)
  }

  private async loadMainIfNeeded(manifest: PluginManifest): Promise<void> {
    if (!manifest.platforms?.includes('main')) return
    try {
      await this.loadMain(manifest.id)
    } catch (err) {
      console.error(`[plugin] 加载主进程插件失败 ${manifest.id}:`, err)
    }
  }

  private async loadMainAfterUpdate(manifest: PluginManifest, oldVersion: string): Promise<void> {
    if (!manifest.platforms?.includes('main')) return
    try {
      const loaded = await this.loadMain(manifest.id)
      if (loaded?.module.onUpdate) {
        try { await loaded.module.onUpdate(oldVersion) } catch (e) { console.error(`[plugin] onUpdate 失败 ${manifest.id}:`, e) }
      }
    } catch (err) {
      console.error(`[plugin] 更新后加载失败 ${manifest.id}:`, err)
    }
  }

  // ===================== 主进程插件加载/卸载 =====================
  private async loadMain(id: string): Promise<LoadedPlugin | null> {
    if (this.loaded.has(id)) return this.loaded.get(id)!
    const dir = join(this.pluginsDir, id)
    const manifest = readManifest(dir)
    const entryName = manifest.main ?? DEFAULT_ENTRY
    const entry = join(dir, entryName)
    if (!existsSync(entry)) throw new Error(`入口文件不存在：${entryName}`)

    const code = readFileSync(entry, 'utf-8')
    // 用 createRequire(entry) 让插件可以 require 自身目录下/相对它的依赖
    const pluginRequire = createRequire(entry)
    const module = evaluatePluginModule({
      code,
      filename: entry,
      dirname: dir,
      require: (name: string) => pluginRequire(name),
    })

    const api = createPluginApi(this.host, manifest.id, manifest.version, dir)
    if (module.setup) await module.setup(api)
    const loaded: LoadedPlugin = { id, manifest, module, api, dir }
    this.loaded.set(id, loaded)
    // 通知生命周期
    this.host.hooks.emit('plugin:loaded', { id, manifest })
    return loaded
  }

  private async unloadMain(id: string): Promise<void> {
    const loaded = this.loaded.get(id)
    if (!loaded) return
    try {
      if (loaded.module.uninstall) await loaded.module.uninstall()
    } catch (err) {
      console.error(`[plugin] uninstall 失败 ${id}:`, err)
    }
    // 回退所有 patch，反订阅所有 hooks
    this.host.patchManager.unpatchAll(getPatchRecords(loaded.api))
    disposeApi(loaded.api)
    this.loaded.delete(id)
    this.host.hooks.emit('plugin:unloaded', { id })
  }

  // ===================== 工具 =====================
  private copyDir(src: string, dest: string): void {
    mkdirSync(dest, { recursive: true })
    cpSync(src, dest, { recursive: true })
  }
}

function ok(id: string, message: string): PluginOperationResult {
  return { success: true, id, message }
}
function fail(message: string): PluginOperationResult {
  return { success: false, message }
}
