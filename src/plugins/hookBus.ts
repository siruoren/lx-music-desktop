/**
 * 轻量钩子总线。
 *
 * 两种用法：
 *  1. 事件（监听）：hooks.on('app:ready', () => {})，发射方 hooks.emit('app:ready', ...)
 *  2. 拦截（覆盖/改写数据流）：hooks.intercept('search:before', (ctx, next) => { ctx.args.x = 1; return next(ctx) })
 *
 * 拦截链中每个 handler 接收 (ctx, next)，可修改 ctx 后再调用 next(ctx)，
 * 也可直接返回而不调用 next（即“覆盖”原流程）。
 */

export type HookHandler = (...args: any[]) => any
export type InterceptHandler = (ctx: any, next: (ctx: any) => any) => any

export class HookBus {
  private readonly listeners = new Map<string, Set<HookHandler>>()
  private readonly interceptors = new Map<string, InterceptHandler[]>()

  /** 监听事件（返回取消函数） */
  on(event: string, handler: HookHandler): () => void {
    let set = this.listeners.get(event)
    if (!set) {
      set = new Set()
      this.listeners.set(event, set)
    }
    set.add(handler)
    return () => { this.off(event, handler) }
  }

  /** 监听一次 */
  once(event: string, handler: HookHandler): () => void {
    const wrapped: HookHandler = (...args) => {
      this.off(event, wrapped)
      return handler(...args)
    }
    return this.on(event, wrapped)
  }

  off(event: string, handler: HookHandler): void {
    this.listeners.get(event)?.delete(handler)
  }

  /** 发射事件，返回所有监听者的返回值数组 */
  emit(event: string, ...args: any[]): any[] {
    const set = this.listeners.get(event)
    if (!set) return []
    const results: any[] = []
    for (const h of set) {
      try {
        results.push(h(...args))
      } catch (err) {
        console.error(`[plugin-hook] event "${event}" handler error:`, err)
      }
    }
    return results
  }

  /**
   * 注册拦截器（用于覆盖/改写数据流）。
   * 多个拦截器按注册顺序组成责任链。
   */
  intercept(name: string, handler: InterceptHandler): () => void {
    let arr = this.interceptors.get(name)
    if (!arr) {
      arr = []
      this.interceptors.set(name, arr)
    }
    arr.push(handler)
    return () => {
      const a = this.interceptors.get(name)
      if (!a) return
      const idx = a.indexOf(handler)
      if (idx !== -1) a.splice(idx, 1)
    }
  }

  /**
   * 执行拦截链。
   * @param name 拦截点名称
   * @param initialCtx 初始上下文对象
   * @param finalFn 责任链末端的最终执行函数（原逻辑），接收 ctx 返回结果
   */
  run(name: string, initialCtx: any, finalFn: (ctx: any) => any): any {
    const chain = this.interceptors.get(name)
    if (!chain || chain.length === 0) return finalFn(initialCtx)
    let i = -1
    const dispatch = (ctx: any): any => {
      i++
      if (i < chain.length) {
        try {
          return chain[i](ctx, dispatch)
        } catch (err) {
          console.error(`[plugin-hook] intercept "${name}" error:`, err)
          return dispatch(ctx)
        }
      }
      return finalFn(ctx)
    }
    return dispatch(initialCtx)
  }

  /** 清空（卸载插件时调用） */
  clear(): void {
    this.listeners.clear()
    this.interceptors.clear()
  }
}
