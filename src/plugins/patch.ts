/**
 * PatchManager —— 运行时函数包装器。
 *
 * 插件“覆盖/修改原代码功能”的关键能力：在不修改源码的前提下，于运行时对
 * 任意对象的方法进行包裹（wrap）。支持多个插件对同一方法叠加包装，并可在
 * 卸载时精确还原原函数，避免“侵入源码却无法回退”。
 *
 * wrapper 签名： (next, ...args) => result
 *  - next 为“被包裹的原实现”（若其它插件也包装了同一方法，则为上一层包装）
 *  - 不调用 next 即“完全覆盖”原功能；调用 next(...args) 即“在原功能前后增强”
 */

type Wrapper = (next: (...a: any[]) => any, ...args: any[]) => any

interface PatchRecord {
  original: any
  wrappers: Wrapper[]
  patched: boolean
}

export class PatchManager {
  // 用 WeakMap 关联对象，避免内存泄漏
  private readonly map = new WeakMap<object, Map<string, PatchRecord>>()

  private getRecord(target: any, method: string): PatchRecord | undefined {
    const obj = target as object
    const methods = this.map.get(obj)
    return methods?.get(method)
  }

  private ensureRecord(target: any, method: string): PatchRecord {
    const obj = target as object
    let methods = this.map.get(obj)
    if (!methods) {
      methods = new Map()
      this.map.set(obj, methods)
    }
    let rec = methods.get(method)
    if (!rec) {
      rec = { original: target[method], wrappers: [], patched: false }
      methods.set(method, rec)
    }
    return rec
  }

  /** 包裹某方法 */
  patch(target: any, method: string, wrapper: Wrapper): void {
    if (target == null) throw new Error(`patch: target is ${target}`)
    if (typeof target[method] !== 'function') throw new Error(`patch: ${method} is not a function`)
    const rec = this.ensureRecord(target, method)
    if (rec.wrappers.includes(wrapper)) return
    rec.wrappers.push(wrapper)
    this.apply(target, method, rec)
  }

  /** 取消某一个 wrapper；不传 wrapper 则取消该方法的所有包装并还原 */
  unpatch(target: any, method: string, wrapper?: Wrapper): void {
    const rec = this.getRecord(target, method)
    if (!rec) return
    if (wrapper) {
      const idx = rec.wrappers.indexOf(wrapper)
      if (idx !== -1) rec.wrappers.splice(idx, 1)
    } else {
      rec.wrappers.length = 0
    }
    if (rec.wrappers.length === 0) {
      // 完全还原原函数
      target[method] = rec.original
      rec.patched = false
      const methods = this.map.get(target as object)
      methods?.delete(method)
    } else {
      this.apply(target, method, rec)
    }
  }

  private apply(target: any, method: string, rec: PatchRecord): void {
    const chain = rec.wrappers
    const original = rec.original
    const callNext = (index: number, args: any[]): any => {
      if (index >= chain.length) return original.apply(target, args)
      return chain[index]((...a: any[]) => callNext(index + 1, a), ...args)
    }
    target[method] = function(this: any, ...args: any[]) {
      return callNext(0, args)
    }
    rec.patched = true
  }

  /** 取消某插件注册的所有 wrapper（按记录的 (target,method,wrapper) 反查） */
  unpatchAll(records: Array<{ target: any, method: string, wrapper: Wrapper }>): void {
    for (const r of records) this.unpatch(r.target, r.method, r.wrapper)
  }
}
