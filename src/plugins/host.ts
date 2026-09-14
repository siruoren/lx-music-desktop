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
import type { PluginApi, PluginPlatform, RendererPluginApi } from './types'

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
