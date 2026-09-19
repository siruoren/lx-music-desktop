/**
 * 插件 API 构造器（main / renderer 共用）。
 *
 * 每个插件在加载时都会拿到一个独立的 PluginApi 实例：
 *  - patch/unpatch 调用会被记录到该插件名下，卸载时统一回退，确保“零残留”。
 *  - hooks 的订阅会被作用域化（scopedHooks），卸载时一并反订阅。
 *  - renderer 端会注入 registerMusicSource / unregisterMusicSource。
 */
import { type PatchManager } from './patch'
import { type HookBus } from './hookBus'
import type { PluginApi, PluginPlatform, PluginSettingsSpec, RendererPluginApi } from './types'

export interface HostContext {
  platform: PluginPlatform
  hooks: HookBus
  patchManager: PatchManager
  app: any
  logger: (pluginId: string) => PluginApi['logger']
  getData: (pluginId: string, key: string, def?: any) => any
  setData: (pluginId: string, key: string, value: any) => void
  registerMusicSource?: (id: string, name: string, module: any) => void
  unregisterMusicSource?: (id: string) => void
  /** 读取插件配置（保存在插件目录 config.json） */
  getConfig?: (pluginId: string) => Record<string, any>
  /** 合并写入插件配置 */
  setConfig?: (pluginId: string, patch: Record<string, any>) => void
  /** 注册插件设置面板（renderer 端才有对应 UI） */
  registerSettings?: (pluginId: string, spec: PluginSettingsSpec) => void
  /**
   * 声明 Chromium 会话代理（仅 main 端提供）。
   * 传入 Electron 的 proxyRules 字符串（如 `'socks5://127.0.0.1:1080'`）即接管，
   * 传 null 撤销接管、回到 app 自身的网络代理设置。用于让「播放」等由 Chromium
   * 直接发起的请求也走代理（详见 ./sessionProxy.ts）。
   */
  setSessionProxy?: (pluginId: string, rules: string | null) => void
  /** 主进程 electron 模块（仅 main 端提供），供插件构造 TouchBar 等原生 GUI 对象 */
  electron?: any
  /** 设置主窗口 Touch Bar（仅 main 端提供，委托 winBridge.setTouchBar） */
  setTouchBar?: (pluginId: string, touchBar: any) => void
  /** 向 renderer 发送播放控制指令（仅 main 端提供，委托 winBridge.controlPlayer） */
  controlPlayer?: (pluginId: string, action: LX.Player.StatusButtonActions, data?: any) => void
}

export interface PatchRecord {
  target: any
  method: string
  wrapper: (next: (...a: any[]) => any, ...args: any[]) => any
}

export function createPluginApi(
  ctx: HostContext,
  pluginId: string,
  version: string,
  dir: string,
): PluginApi | RendererPluginApi {
  const patchRecords: PatchRecord[] = []
  const disposers: Array<() => void> = []

  // —— 生命周期资源登记（应用退出 / 插件卸载时由宿主**同步**强制回收）——
  // 宿主代管的定时器与登记的清理回调集中在这里，runShutdown 一次性回收，
  // 插件忘记清理也不会把后台任务（下载、子进程、定时同步…）残留到退出之后。
  const timers = new Set<ReturnType<typeof setTimeout>>()
  const quitCallbacks: Array<() => void> = []
  const trackedDisposers: Array<() => void> = []
  /** 临时执行状态：每次加载都从空开始（进程重启 / 重载后自动重置），只存内存、绝不落盘 */
  let runtime: Record<string, any> = {}
  let shutdownDone = false

  // 作用域化的 hooks：订阅时自动记录反订阅函数
  const scopedHooks = {
    on: (event: string, handler: (...args: any[]) => any) => {
      const off = ctx.hooks.on(event, handler)
      disposers.push(off)
      return off
    },
    once: (event: string, handler: (...args: any[]) => any) => {
      const off = ctx.hooks.once(event, handler)
      disposers.push(off)
      return off
    },
    off: (event: string, handler: (...args: any[]) => any) => { ctx.hooks.off(event, handler) },
    emit: (event: string, ...args: any[]) => ctx.hooks.emit(event, ...args),
    intercept: (name: string, handler: (ctx: any, next: (c: any) => any) => any) => {
      const off = ctx.hooks.intercept(name, handler)
      disposers.push(off)
      return off
    },
    run: (name: string, initialCtx: any, finalFn: (c: any) => any) => ctx.hooks.run(name, initialCtx, finalFn),
    clear: () => {
      for (const d of disposers.splice(0)) {
        try { d() } catch { /* noop */ }
      }
    },
  }

  const api: any = {
    id: pluginId,
    version,
    dir,
    platform: ctx.platform,
    logger: ctx.logger(pluginId),
    hooks: scopedHooks,
    app: ctx.app,
    patch: (target: any, method: string, wrapper: PatchRecord['wrapper']) => {
      ctx.patchManager.patch(target, method, wrapper)
      patchRecords.push({ target, method, wrapper })
    },
    unpatch: (target: any, method: string, wrapper?: PatchRecord['wrapper']) => {
      ctx.patchManager.unpatch(target, method, wrapper)
      if (wrapper) {
        const i = patchRecords.findIndex(r => r.target === target && r.method === method && r.wrapper === wrapper)
        if (i !== -1) patchRecords.splice(i, 1)
      } else {
        patchRecords.length = 0
      }
    },
    getData: (key: string, def?: any) => ctx.getData(pluginId, key, def),
    setData: (key: string, value: any) => { ctx.setData(pluginId, key, value) },

    // —— 生命周期资源登记：应用退出 / 插件卸载时由宿主同步强制回收 ——

    /** 登记「应用退出时执行的同步清理回调」，返回撤销函数（与 module.onQuit 等价） */
    onQuit: (handler: () => void) => {
      if (typeof handler !== 'function') return () => {}
      quitCallbacks.push(handler)
      return () => {
        const i = quitCallbacks.indexOf(handler)
        if (i !== -1) quitCallbacks.splice(i, 1)
      }
    },
    /** 登记一个同步资源回收函数（子进程 kill / socket destroy / 关闭句柄等），返回撤销函数 */
    track: (disposer: () => void) => {
      if (typeof disposer !== 'function') return () => {}
      trackedDisposers.push(disposer)
      return () => {
        const i = trackedDisposers.indexOf(disposer)
        if (i !== -1) trackedDisposers.splice(i, 1)
      }
    },
    /** 宿主代管的 setTimeout：退出 / 卸载时自动清除，回调异常被捕获不影响其它逻辑 */
    setTimeout: (fn: () => void, ms: number) => {
      const handle = setTimeout(() => {
        timers.delete(handle)
        try { fn() } catch (err) { console.error(`[plugin:${pluginId}] setTimeout 回调失败：`, err) }
      }, ms)
      timers.add(handle)
      return handle
    },
    /** 宿主代管的 setInterval：退出 / 卸载时自动清除，回调异常被捕获不影响后续触发 */
    setInterval: (fn: () => void, ms: number) => {
      const handle = setInterval(() => {
        try { fn() } catch (err) { console.error(`[plugin:${pluginId}] setInterval 回调失败：`, err) }
      }, ms)
      timers.add(handle)
      return handle
    },
    clearTimeout: (handle: ReturnType<typeof setTimeout>) => {
      timers.delete(handle)
      clearTimeout(handle)
    },
    clearInterval: (handle: ReturnType<typeof setTimeout>) => {
      timers.delete(handle)
      clearInterval(handle)
    },

    // —— 临时执行状态：每次启动 / 重载自动清空（这正是「启动后执行状态重载」的保证）——
    getRuntime: (): Record<string, any> => runtime,
    setRuntime: (patch: Record<string, any>): Record<string, any> => {
      runtime = Object.assign({}, runtime, patch ?? {})
      return runtime
    },
  }

  // 供 runShutdown 使用的生命周期登记（挂在 api 上，宿主各处都能拿到）
  ;(api as any).__lifecycle = { timers, quitCallbacks, trackedDisposers, get done() { return shutdownDone }, set done(v: boolean) { shutdownDone = v } }

  if (ctx.registerMusicSource) {
    api.registerMusicSource = ctx.registerMusicSource
    api.unregisterMusicSource = ctx.unregisterMusicSource
  }

  // 插件配置：与 api.getData/setData 分开存放，固定落在插件目录的 config.json，
  // 用于「插件设置」面板；getData/setData 仍是插件自由使用的键值存储。
  // 宿主没提供配置能力时退化为本实例内的内存对象，保证插件不因缺少能力而崩溃。
  const localConfig: Record<string, any> = {}
  api.getConfig = () => Object.assign({}, ctx.getConfig ? ctx.getConfig(pluginId) : localConfig)
  api.setConfig = (patch: Record<string, any>) => {
    if (ctx.setConfig) ctx.setConfig(pluginId, patch ?? {})
    else Object.assign(localConfig, patch ?? {})
  }
  // 设置面板只在有 UI 的宿主（renderer）里可用；main 端不提供，插件据此判断能否被配置
  if (ctx.registerSettings) {
    api.registerSettings = (spec: PluginSettingsSpec) => { ctx.registerSettings!(pluginId, spec) }
  }

  // Chromium 会话代理接管（仅 main 端）：让 <audio>/<img> 等 Chromium 直接发起的
  // 请求也走插件提供的代理，否则只有 Node 的 http.Agent 被接管，播放仍会直连。
  if (ctx.setSessionProxy) {
    api.setSessionProxy = (rules: string | null) => { ctx.setSessionProxy!(pluginId, rules ?? null) }
  }

  // 主进程 electron 模块（仅 main 端）：供插件构造 TouchBar 等原生 GUI 对象
  if (ctx.electron) {
    api.electron = ctx.electron
  }
  // 设置主窗口 Touch Bar（仅 main 端，仅 macOS 生效）；窗口未就绪时由 winBridge 挂起
  if (ctx.setTouchBar) {
    api.setTouchBar = (touchBar: any) => { ctx.setTouchBar!(pluginId, touchBar) }
  }
  // 向 renderer 发送播放控制指令（仅 main 端，action 同 taskbar 按钮）
  if (ctx.controlPlayer) {
    api.controlPlayer = (action: LX.Player.StatusButtonActions, data?: any) => { ctx.controlPlayer!(pluginId, action, data) }
  }

  // 供卸载时回退使用
  ;(api).__patchRecords = patchRecords
  ;(api).__disposers = disposers
  return api
}

export function getPatchRecords(api: PluginApi): PatchRecord[] {
  return (api as any).__patchRecords ?? []
}

/**
 * 同步强制回收插件登记的运行期资源（宿主在「应用退出」与「卸载/禁用插件」时调用）：
 *  1. 清掉所有通过 api.setTimeout / api.setInterval 建立的定时器；
 *  2. 依次执行 api.onQuit / api.track 登记的同步清理回调（中断下载、kill 子进程等）。
 *
 * 幂等：重复调用只生效一次；全程捕获异常，单个回调失败不影响其它资源回收。
 * 注意：这**不是卸载**——patch / hooks 不在此回退，插件本体保持已加载状态；
 * 回退现场是 disposeApi（卸载）的职责。
 *
 * @returns 实际回收的资源数量（定时器 + 回调），供日志展示
 */
export function runShutdown(api: PluginApi): number {
  const lc: any = (api as any).__lifecycle
  if (!lc || lc.done) return 0
  lc.done = true
  let collected = 0
  for (const handle of [...lc.timers as Set<ReturnType<typeof setTimeout>>]) {
    try { clearTimeout(handle); clearInterval(handle) } catch { /* noop */ }
  }
  collected += lc.timers.size
  lc.timers.clear()
  const callbacks: Array<() => void> = [...lc.quitCallbacks, ...lc.trackedDisposers]
  lc.quitCallbacks.length = 0
  lc.trackedDisposers.length = 0
  for (const fn of callbacks) {
    try {
      fn()
      collected++
    } catch (err) {
      console.error(`[plugin:${api.id}] 退出清理回调执行失败：`, err)
    }
  }
  return collected
}

export function disposeApi(api: PluginApi): void {
  // 先回收插件登记的运行期资源（定时器 / 清理回调），再反订阅 hooks
  runShutdown(api)
  const disposers: Array<() => void> = (api as any).__disposers ?? []
  for (const d of disposers) {
    try { d() } catch { /* noop */ }
  }
}
