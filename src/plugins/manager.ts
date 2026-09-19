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
import { EnabledState, PluginConfigStore, atomicWrite } from './storage'
import { readManifest, checkCompatibility } from './manifest'
import { compareVersion } from './semver'
import { createPluginApi, getPatchRecords, disposeApi, runShutdown } from './host'
import { evaluatePluginModule } from './loader'
import { parsePluginFile, isPluginFileName, DEFAULT_ENTRY, PLUGIN_FILE_EXT, MAX_PLUGIN_FILE_SIZE } from './format'
import type { HostContext } from './host'
import type {
  PluginInfo,
  PluginManifest,
  PluginModule,
  PluginOperationResult,
} from './types'

// ⚠️ 不要写 `import { createRequire } from 'module'`：webpack（target: electron-main）
// 会把它编译成 `/* createRequire() */ undefined`（'module' 不在该目标的内置模块
// 外置列表里），导致 main 端所有插件在求值时报 "pluginRequire is not a function"
// 而全部加载失败（renderer 端走 nodeIntegration 的 require，不受影响）。
// 必须用 webpack 的逃逸口 __non_webpack_require__ 拿到原生 require。
// ⚠️ 类型签名不要 `import type { CreateRequire } from 'module'`：该具名类型导出
// 在仓库锁定的 @types/node 版本里不存在（CI 报 TS2724）。createRequire 的返回值
// 本来就是全局类型 NodeRequire，直接手写等价的函数签名即可。
declare const __non_webpack_require__: NodeRequire
const getCreateRequire = (): (filename: string | URL) => NodeRequire =>
  __non_webpack_require__('module').createRequire

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
  /** 各插件的配置存储（<插件目录>/config.json） */
  readonly config: PluginConfigStore
  private readonly enabled: EnabledState
  private readonly host: HostContext
  private readonly loaded = new Map<string, LoadedPlugin>()
  /**
   * 各插件“最近一次实际加载结果”，用于让列表状态反映真实情况。
   *  - main 端插件：由本类在 loadMain/unloadMain 中写入；
   *  - renderer 端插件：由 renderer 宿主经 reportState 回传。
   * 主进程的 loaded 只包含 main 端插件，因此不能用它判断 renderer 端插件是否已启用。
   */
  private readonly runtimeState = new Map<string, { loaded: boolean, error?: string }>()
  /** shutdownAll 是否已执行过（before-quit 与 will-quit 都会触发，需幂等）；新插件加载后重置 */
  private quitHandled = false

  constructor(pluginsDir: string, host: HostContext) {
    this.pluginsDir = pluginsDir
    if (!existsSync(pluginsDir)) mkdirSync(pluginsDir, { recursive: true })
    this.enabled = new EnabledState(pluginsDir)
    this.config = new PluginConfigStore(pluginsDir)
    this.host = host
  }

  /** 读取某插件的配置（保存在 <插件目录>/config.json） */
  getConfig(id: string): Record<string, any> {
    return this.config.read(id)
  }

  /** 合并写入某插件配置，返回写入后的完整配置 */
  setConfig(id: string, patch: Record<string, any>): Record<string, any> {
    const next = this.config.patch(id, patch)
    // 主进程插件同样要感知配置变化：设置面板是在 renderer 里改的，但 main 端的插件
    // （如 sock_proxy 的 Chromium 会话代理/本地桥）必须立刻跟着更新，否则要重启才生效。
    const loaded = this.loaded.get(id)
    if (loaded?.module.onConfigChange) {
      try {
        void Promise.resolve(loaded.module.onConfigChange(next)).catch(err => {
          console.error(`[plugin] onConfigChange 执行失败 ${id}:`, err)
        })
      } catch (err) {
        console.error(`[plugin] onConfigChange 执行失败 ${id}:`, err)
      }
    }
    return next
  }

  // ===================== 扫描 / 列表 =====================
  /**
   * 列出已安装插件。
   *
   * status 语义（UI 直接展示，所以必须反映真实情况）：
   *  - disabled：启用开关为关；
   *  - incompatible：已启用但与当前客户端版本不兼容；
   *  - error：已启用且兼容，但加载方明确报告加载/执行失败（error 字段给出原因）；
   *  - enabled：已启用且无失败记录。
   *
   * 注意：不能用「主进程 loaded 表」来判断是否已启用——它只包含 main 端插件，
   * 会导致 renderer 端插件恒显示为「已禁用」。
   */
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
        let error: string | undefined
        if (enabled) {
          // 只有“启用”的插件才需要判断能不能真正跑起来
          const incompat = checkCompatibility(manifest)
          if (incompat) {
            status = 'incompatible'
            error = incompat
          } else {
            const rt = this.runtimeState.get(manifest.id)
            if (rt && !rt.loaded) {
              // 加载方（main 本进程 / renderer 经 IPC 上报）明确报告失败
              status = 'error'
              error = rt.error ?? '插件加载失败'
            } else {
              // 尚未上报（如 renderer 端仍在异步加载）时按“已启用”展示，避免误报为已禁用
              status = 'enabled'
            }
          }
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
          error,
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

  /**
   * renderer 宿主上报某插件的加载结果（启用/禁用后由 UI 触发的热加载，或启动期自动加载）。
   * 'unloaded' 表示已卸载，回到“由启用开关决定”的未知态。
   */
  reportRuntimeState(id: string, state: 'loaded' | 'unloaded' | 'error', error?: string): void {
    if (!id) return
    if (state === 'unloaded') {
      this.runtimeState.delete(id)
      return
    }
    this.runtimeState.set(id, state === 'loaded' ? { loaded: true } : { loaded: false, error })
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
   * 应用退出时**同步终止**所有已加载主进程插件的后台工作（定时器、子进程、下载等）。
   * 注意：这不是卸载——不调用 uninstall、不回退 patch / hooks（进程即将退出，无需恢复现场）；
   * 只广播 `app:quit` 并回收宿主代管的资源，保证插件派生的后台进程/任务不会残留到退出之后。
   */
  shutdownAll(): void {
    if (this.quitHandled) return
    this.quitHandled = true
    try { this.host.hooks.emit('app:quit', { reason: 'app-quit' }) } catch (err) { console.error('[plugin] 广播 app:quit 失败：', err) }
    for (const [id, loaded] of this.loaded) {
      try {
        runShutdown(loaded.api)
        loaded.module.onQuit?.()
      } catch (err) {
        console.error(`[plugin] 退出时终止插件后台任务失败 ${id}:`, err)
      }
    }
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
    // 清掉运行期状态，避免卸载后重新安装同 id 时继承上一次的加载结果
    this.runtimeState.delete(id)
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
    // 允许同版本覆盖更新（插件版本自动跟随 app 版本，纯插件修复无法靠升版本号触发更新）；
    // 仅拒绝降级（新版本 < 旧版本）。更新经 withPreservedFiles 保留 config.json/data.json，不丢配置。
    if (compareVersion(newManifest.version, oldManifest.version) < 0) {
      return fail(`新版本（${newManifest.version}）低于已安装版本（${oldManifest.version}），无法降级`)
    }
    const compat = checkCompatibility(newManifest)
    if (compat) return fail(`与当前客户端不兼容：${compat}`)

    const oldVersion = oldManifest.version
    await this.unloadMain(id)
    try {
      // 保留插件自己的 config.json / data.json
      this.withPreservedFiles(target, () => {
        mkdirSync(target, { recursive: true })
        this.copyDir(fromDir, target)
      })
    } catch (err) {
      return fail(`更新文件失败：${(err as Error).message}`)
    }
    this.enabled.setEnabled(id, true)
    // 换成了新代码，先清掉旧版本的加载结果
    this.runtimeState.delete(id)
    await this.loadMainAfterUpdate(newManifest, oldVersion)
    return ok(id, `已更新 ${newManifest.name}@${newManifest.version}`)
  }

  // ===================== 启用 / 禁用 =====================
  async enable(id: string): Promise<PluginOperationResult> {
    const target = join(this.pluginsDir, id)
    if (!existsSync(target)) return fail(`插件未安装：${id}`)
    this.enabled.setEnabled(id, true)
    // 清掉上一次的加载结果，给本次启用一个干净的重试机会（加载方会重新上报）
    this.runtimeState.delete(id)
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
    this.runtimeState.delete(id)
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
    // 允许同版本覆盖更新（插件版本自动跟随 app 版本，纯插件修复无法靠升版本号触发更新）；
    // 仅拒绝降级（新版本 < 旧版本）。更新经 withPreservedFiles 保留 config.json/data.json，不丢配置。
    if (compareVersion(manifest.version, oldManifest.version) < 0) {
      return fail(`新版本（${manifest.version}）低于已安装版本（${oldManifest.version}），无法降级`)
    }
    const compat = checkCompatibility(manifest)
    if (compat) return fail(`与当前客户端不兼容：${compat}`)

    const oldVersion = oldManifest.version
    await this.unloadMain(id)
    try {
      // 保留插件自己的 config.json / data.json
      this.withPreservedFiles(target, () => {
        this.writePlugin(target, manifest, code)
      })
    } catch (err) {
      return fail(`更新文件失败：${(err as Error).message}`)
    }
    this.enabled.setEnabled(id, true)
    // 换成了新代码，先清掉旧版本的加载结果
    this.runtimeState.delete(id)
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
    try {
      const loaded = await this.doLoadMain(id)
      this.runtimeState.set(id, { loaded: true })
      return loaded
    } catch (err) {
      // 记录失败原因：列表中会显示为「出错」并给出原因，而不是含糊的「已禁用」
      this.runtimeState.set(id, { loaded: false, error: (err as Error).message })
      throw err
    }
  }

  private async doLoadMain(id: string): Promise<LoadedPlugin> {
    const dir = join(this.pluginsDir, id)
    const manifest = readManifest(dir)
    const entryName = manifest.main ?? DEFAULT_ENTRY
    const entry = join(dir, entryName)
    if (!existsSync(entry)) throw new Error(`入口文件不存在：${entryName}`)

    const code = readFileSync(entry, 'utf-8')
    // 用 createRequire(entry) 让插件可以 require 自身目录下/相对它的依赖
    const pluginRequire = getCreateRequire()(entry)
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
    // 新插件加载后需要为它保留一次「退出终止」的机会
    this.quitHandled = false
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
    this.runtimeState.delete(id)
    this.host.hooks.emit('plugin:unloaded', { id })
  }

  // ===================== 工具 =====================
  /**
   * 更新插件会先清空插件目录，但**插件自己的配置与数据必须保留**：
   *  - config.json：插件设置面板保存的配置（每个插件单独存在自己目录里）
   *  - data.json：api.getData/setData 持久化的数据
   * 否则每次更新插件都会丢掉用户配置。
   */
  private withPreservedFiles(target: string, fn: () => void): void {
    const preserved = PRESERVED_FILES
      .map(name => ({ name, file: join(target, name) }))
      .filter(item => existsSync(item.file))
      .map(item => ({ name: item.name, content: readFileSync(item.file, 'utf-8') }))

    rmSync(target, { recursive: true, force: true })
    fn()
    for (const item of preserved) {
      try {
        // 用原子写入恢复，避免更新插件途中被杀导致 config.json / data.json 只剩半截
        atomicWrite(join(target, item.name), item.content)
      } catch (err) {
        console.error(`[plugin] 恢复 ${item.name} 失败（${target}）：`, err)
      }
    }
  }

  private copyDir(src: string, dest: string): void {
    mkdirSync(dest, { recursive: true })
    cpSync(src, dest, { recursive: true })
  }
}

/** 更新插件时需要跨版本保留的文件（相对于插件目录） */
const PRESERVED_FILES = ['config.json', 'data.json']

function ok(id: string, message: string): PluginOperationResult {
  return { success: true, id, message }
}
function fail(message: string): PluginOperationResult {
  return { success: false, message }
}
