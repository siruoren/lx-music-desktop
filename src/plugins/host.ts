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
  controlPlayer?: (pluginId: string, action: string, data?: any) => void
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
  }

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

export function disposeApi(api: PluginApi): void {
  const disposers: Array<() => void> = (api as any).__disposers ?? []
  for (const d of disposers) {
    try { d() } catch { /* noop */ }
  }
}
