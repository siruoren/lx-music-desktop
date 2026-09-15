/**
 * 插件系统 - renderer 宿主（initUserPlugins）。
 *
 * 职责：
 *  1. 通过 IPC 调用主进程管理器完成“安装/卸载/更新/启用/禁用/列表”。
 *  2. 加载“renderer 端插件”：从主进程取回入口源码后，用 loader 在 CommonJS 语义下求值并执行 setup。
 *  3. 在 window.lx.plugins 暴露宿主 API（hooks/patch/registerMusicSource/管理/load/unload）。
 *  4. 维护 window.lx.pluginMusicSources（Map），musicSdk 会将其合入音乐源。
 *  5. 暴露 window.lx.musicSdk，便于插件以 api.patch 覆盖原搜索/列表等功能。
 *  6. 插件配置：实体保存在 <插件目录>/config.json，插件经 api.getConfig/setConfig 读写，
 *     并可通过 api.registerSettings 声明式注册设置面板（UI 见 ui/PluginSettingsPanel.vue）。
 *  7. app 自定义源集成：插件导入的远程源脚本经 window.lx.plugins.userApi 落到 app 的
 *     「自定义源」列表中，且导入后立刻同步界面 store。
 *
 * renderer 侧对源代码的侵入共四处（均带 `Plugin Manager` 标记）：
 *  - src/renderer/main.ts 中调用 initUserPlugins(app)
 *  - src/renderer/utils/musicSdk/index.js 中合并 window.lx.pluginMusicSources
 *  - src/renderer/utils/request.js 的 getRequestAgent 中查询 window.lx.pluginNetAgent（插件接管代理 agent）
 *  - src/renderer/views/Setting/index.vue 中挂上「插件管理」标签页（src/plugins/ui/SettingPlugins.vue）
 */
import { ipcRenderer } from 'electron'
import musicSdk from '@renderer/utils/musicSdk'
import { userApi } from '@renderer/store'
import { appSetting, setApiSource } from '@renderer/store/setting'
import { getUserApiList, importUserApi, removeUserApi } from '@renderer/utils/ipc'
// === Plugin Manager === 收藏数据桥：让插件能读取/写回「我的列表」（收藏）
import { getListMusics, overwriteListFull } from '@renderer/store/list/action'
import { defaultList, loveList, userLists } from '@renderer/store/list/state'
import { fixNewMusicInfoQuality, filterMusicList } from '@renderer/utils'
import { toRaw } from '@common/utils/vueTools'
import { LIST_IDS } from '@common/constants'
import { HookBus } from './hookBus'
import { PatchManager } from './patch'
import { createPluginApi, getPatchRecords, disposeApi } from './host'
import type { HostContext } from './host'
import { evaluatePluginModule } from './loader'
import type { ModuleRequire } from './loader'
import { PLUGIN_IPC } from './ipc'
import { parsePluginFile } from './format'
import { getAppVersion } from './validate'
import type { PluginApi, PluginManifest, PluginModule, PluginOperationResult, PluginInfo, PluginSettingsSpec } from './types'

let rendererHooks: HookBus
let rendererPatch: PatchManager
let rendererHostCtx: HostContext
// 已注册的音乐源：id -> { name, module }
const musicSources = new Map<string, { name: string, module: any }>()
// 已加载的 renderer 插件
const loadedRenderers = new Map<string, { module: PluginModule, api: PluginApi }>()
// 各插件注册的设置面板描述
const pluginSettings = new Map<string, PluginSettingsSpec>()
/**
 * 各插件的配置内存副本。
 * 配置实体保存在 <插件目录>/config.json（由主进程读写），加载插件时一次性取回，
 * 这样插件的 api.getConfig() 可以保持同步，写入则「先更内存、再异步落盘」。
 */
const pluginConfig = new Map<string, Record<string, any>>()

type ConfigChangeListener = (id: string, config: Record<string, any>) => void
/** 设置面板每次写入配置后通知订阅者（设置面板要刷新显示） */
const configListeners = new Set<ConfigChangeListener>()

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

/* ===================== 插件配置（<插件目录>/config.json） =====================
 * 配置实体由主进程写在插件自己的目录里（各插件彼此隔离，不污染 app 设置）。
 * 加载插件时一次性取回放入内存副本，于是 api.getConfig() 可以保持同步；
 * 写入则是「先更新内存、再异步落盘」，插件与设置面板都能立刻读到新值。
 */

function getConfigOf(id: string): Record<string, any> {
  return pluginConfig.get(id) ?? {}
}

/** 加载插件前调用：从主进程取回该插件的配置 */
async function fetchConfig(id: string): Promise<Record<string, any>> {
  try {
    const cfg = await invoke<Record<string, any>>(PLUGIN_IPC.configRead, { id })
    const value = cfg && typeof cfg === 'object' ? cfg : {}
    pluginConfig.set(id, value)
    return value
  } catch (err) {
    console.error(`[plugin] 读取插件配置失败 ${id}:`, err)
    pluginConfig.set(id, {})
    return {}
  }
}

/** 合并写入插件配置：同步更新内存副本，异步持久化到插件目录 */
function setConfigOf(id: string, patch: Record<string, any>): Record<string, any> {
  const next = Object.assign({}, getConfigOf(id), patch ?? {})
  pluginConfig.set(id, next)
  void invoke(PLUGIN_IPC.configWrite, { id, patch: next }).catch(err => {
    console.error(`[plugin] 保存插件配置失败 ${id}:`, err)
  })
  for (const listener of configListeners) {
    try { listener(id, next) } catch (err) { console.error('[plugin] 配置变更通知失败：', err) }
  }
  return next
}

function registerSettings(id: string, spec: PluginSettingsSpec): void {
  if (!spec || !Array.isArray(spec.fields)) {
    console.warn(`[plugin] registerSettings 参数不合法，已忽略：${id}`)
    return
  }
  pluginSettings.set(id, spec)
}

/** 读取配置并补齐面板字段声明的默认值（只影响返回值，不写回文件） */
function withDefaults(id: string): Record<string, any> {
  const spec = pluginSettings.get(id)
  const result: Record<string, any> = Object.assign({}, getConfigOf(id))
  if (!spec) return result
  for (const field of spec.fields) {
    if (!field.key) continue
    if (result[field.key] === undefined && field.default !== undefined) result[field.key] = field.default
  }
  return result
}

/** 配置写入后通知插件本身，让新配置立即生效（无需重启客户端） */
async function notifyConfigChange(id: string, config: Record<string, any>): Promise<void> {
  const rec = loadedRenderers.get(id)
  if (!rec?.module.onConfigChange) return
  try {
    await rec.module.onConfigChange(config)
  } catch (err) {
    console.error(`[plugin] onConfigChange 执行失败 ${id}:`, err)
  }
}

/* ===================== app「自定义源」集成 =====================
 * 插件批量导入的远程自定义源脚本要出现在 app 的「设置 → 基本设置 → 自定义源」列表中，
 * 因此这里把 app 自身的自定义源能力（导入 / 移除 / 列表 / 当前选中项）暴露给插件，
 * 并在每次变更后同步 renderer 的 userApi store，让界面立即反映出来。
 */
const userApiBridge = {
  /** 当前已导入的自定义源列表（同步读 store） */
  list: (): any[] => userApi.list,
  /** 从主进程重新拉取列表并刷新界面 */
  refresh: async(): Promise<any[]> => {
    const list = await getUserApiList()
    userApi.list = list
    return list
  },
  /**
   * 导入一个自定义源脚本（与 app 的「在线导入自定义源」同一接口）。
   * 注意：该接口每次都生成新的源 id，无法原地覆盖；
   * 因此“更新某个源”需要先 remove 再 import。
   */
  importScript: async(script: string): Promise<{ success: boolean, apiInfo?: any, message?: string }> => {
    try {
      const res = await importUserApi(script)
      userApi.list = res.apiList
      return { success: true, apiInfo: res.apiInfo }
    } catch (err) {
      return { success: false, message: (err as Error).message }
    }
  },
  /** 移除若干自定义源，返回移除后的列表 */
  remove: async(ids: string[]): Promise<any[]> => {
    const list = await removeUserApi(ids)
    userApi.list = list
    return list
  },
  /** 当前选中的自定义源 id（app 设置项 common.apiSource） */
  getActiveId: (): string => appSetting['common.apiSource'],
  /** 选中某个自定义源，等价于用户在「自定义源」列表里勾选 */
  setActiveId: (id: string): void => {
    setApiSource(id)
  },
}

/* ===================== 收藏（我的列表）数据桥 =====================
 * 让插件能读取/写回客户端的「我的列表」（试听列表 + 我的收藏 + 创建的歌单）。
 * 渲染端收藏数据存于 SQLite（lx.data.db），且读写必须经由 store action；
 * 这些 action 不在 window.lx 上暴露，故在此集中桥接，供 sync-favorites 等插件调用。
 * 导出格式与设置「备份/还原」一致：[{ ...list, list }, ...]。
 * scope 控制同步范围（可选类别：default=试听列表 / love=我的收藏 / user=我的列表(歌单)），
 * 不传则三类全同步；importAll 会保留未选中类别的现有内容，不会误清空。
 */
function scopeIncludes(scope: any, category: 'default' | 'love' | 'user'): boolean {
  if (scope == null) return true
  if (typeof scope === 'string') {
    const s = String(scope).trim()
    if (s === '' || s === 'all') return true
    const parts = s.split(',').map(x => x.trim())
    return parts.includes(category)
  }
  if (typeof scope === 'object') return scope[category] !== false
  return true
}

const listDataBridge = {
  /** 读取当前列表（按 scope 过滤；默认 default/love/user 全部）及其歌曲 */
  exportAll: async(scope?: any): Promise<any[]> => {
    const lists: any[] = []
    if (scopeIncludes(scope, 'default')) {
      lists.push({ ...toRaw(defaultList), list: toRaw(await getListMusics(defaultList.id)) })
    }
    if (scopeIncludes(scope, 'love')) {
      lists.push({ ...toRaw(loveList), list: toRaw(await getListMusics(loveList.id)) })
    }
    if (scopeIncludes(scope, 'user')) {
      for (const list of userLists) {
        lists.push({ ...toRaw(list), list: toRaw(await getListMusics(list.id)) })
      }
    }
    return lists
  },
  /** 写回列表：按 id 匹配覆盖、本地不存在则新增（与导入 v2 备份同语义）。
   *  scope 未包含的类别会读回当前内容保持原样，避免 overwriteListFull 整体覆盖时误清空。 */
  importAll: async(lists: any[], scope?: any): Promise<void> => {
    if (!Array.isArray(lists)) throw new Error('收藏数据格式错误')
    const wantDefault = scopeIncludes(scope, 'default')
    const wantLove = scopeIncludes(scope, 'love')
    const wantUser = scopeIncludes(scope, 'user')
    const defaultEl = lists.find(l => l.id === LIST_IDS.DEFAULT)
    const loveEl = lists.find(l => l.id === LIST_IDS.LOVE)
    const others = lists.filter(l => l.id !== LIST_IDS.DEFAULT && l.id !== LIST_IDS.LOVE)
    const toRawArr = (arr: any) => (Array.isArray(arr) ? toRaw(arr) : [])
    const mapList = (arr: any[] | undefined) => filterMusicList(toRawArr(arr)).map(m => fixNewMusicInfoQuality(m))
    // 未选中的类别：读回当前内容（overwriteListFull 会整体覆盖三类，必须回填以保持原样）
    const keepDefault = wantDefault ? [] : toRaw(await getListMusics(defaultList.id))
    const keepLove = wantLove ? [] : toRaw(await getListMusics(loveList.id))
    const keepUser = wantUser ? [] : await Promise.all(toRaw(userLists).map(async(l) => {
      const raw = toRaw(l)
      return { ...raw, list: toRaw(await getListMusics(raw.id)) }
    }))
    await overwriteListFull({
      defaultList: mapList(wantDefault ? defaultEl?.list : keepDefault),
      loveList: mapList(wantLove ? loveEl?.list : keepLove),
      userList: wantUser
        ? others.map(l => ({ ...l, list: mapList(l.list) }))
        : keepUser,
    })
  },
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
    // 先把该插件的配置（<插件目录>/config.json）取回内存，
    // 这样插件在 setup 里就能同步读到自己的配置，改完配置下次启动也依然生效。
    await fetchConfig(id)
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
  // 插件已卸载：设置面板与内存中的配置一并清掉（配置文件仍留在插件目录里）
  pluginSettings.delete(id)
  pluginConfig.delete(id)
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
    getConfig: getConfigOf,
    setConfig: setConfigOf,
    registerSettings,
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

  // ---- 插件设置面板：面板描述 + 配置读写（配置保存在插件目录 config.json）----
  // 面板由宿主统一渲染，插件只需声明字段，因此插件产物仍是单个文件。
  hostApi.settings = {
    /** 某插件注册的设置面板描述；未注册或插件未加载时为 null */
    get: (id: string): PluginSettingsSpec | null => pluginSettings.get(id) ?? null,
    /** 是否已注册设置面板（UI 据此决定要不要显示「设置」按钮） */
    has: (id: string): boolean => pluginSettings.has(id),
    /** 读取配置（补齐字段 default） */
    getConfig: (id: string): Record<string, any> => withDefaults(id),
    /** 合并写入配置并通知插件立即生效 */
    setConfig: (id: string, patch: Record<string, any>): Record<string, any> => {
      const next = setConfigOf(id, patch)
      void notifyConfigChange(id, next)
      return next
    },
    /** 点击面板上的按钮 */
    runAction: async(id: string, action: string): Promise<void> => {
      const rec = loadedRenderers.get(id)
      if (!rec?.module.onSettingsAction) return
      try {
        await rec.module.onSettingsAction(action, getConfigOf(id))
      } catch (err) {
        console.error(`[plugin] 设置动作执行失败 ${id}.${action}:`, err)
      }
    },
    /** 订阅配置变化（设置面板据此刷新显示）；返回取消订阅函数 */
    subscribe: (listener: ConfigChangeListener): (() => void) => {
      configListeners.add(listener)
      return () => { configListeners.delete(listener) }
    },
  }

  // ---- app 自定义源集成：插件导入的源会出现在 app 的「自定义源」列表里 ----
  hostApi.userApi = userApiBridge

  // ---- 收藏（我的列表）数据桥：供 sync-favorites 等插件备份/还原收藏 ----
  hostApi.listData = listDataBridge

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
