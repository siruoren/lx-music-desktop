/**
 * 插件模块求值器（main / renderer 共用）。
 *
 * 为什么不用动态 `import()`：
 *  - 插件的入口文件在运行时才存在（用户安装到 userData 下），webpack 无法静态分析，
 *    `import(表达式)` 会被打包器改写为上下文模块，导致运行期找不到模块；
 *  - 单文件插件的产物是 CommonJS，直接求值最稳妥，也便于统一注入 `require` 沙箱。
 *
 * 因此这里用 `new Function` 构造一个 CommonJS 工厂来执行插件代码：
 *  - 插件拿到独立的 `module` / `exports` / `require` / `__filename` / `__dirname`；
 *  - `require` 由各端各自注入（main 端基于 createRequire，renderer 端基于 nodeIntegration 的 require）；
 *  - 不做字符串改写、不做打包，卸载时宿主统一回退 patch 与 hooks，保证零残留。
 *
 * 安全说明：插件是用户显式安装并启用的可执行代码，与用户直接运行脚本等价；
 * 本插件系统不做沙箱隔离，仅保证「安装/解析清单阶段不执行插件代码」。
 */
import type { PluginModule } from './types'

export type ModuleRequire = (id: string) => any

export interface EvaluatePluginModuleOptions {
  /** 插件入口文件的源码 */
  code: string
  /** 入口文件的绝对路径（注入 __filename） */
  filename?: string
  /** 入口文件所在目录（注入 __dirname） */
  dirname?: string
  /** 模块 require 实现；不传时插件内 require 会抛出明确错误 */
  require?: ModuleRequire
}

interface CommonJsModule {
  exports: any
}

/**
 * 在 CommonJS 语义下求值插件代码，返回插件生命周期对象。
 * @throws 代码执行出错、或导出的模块不含任何生命周期函数时抛出异常
 */
export function evaluatePluginModule(options: EvaluatePluginModuleOptions): PluginModule {
  const { code, filename = '', dirname = '' } = options
  if (typeof code !== 'string' || !code.trim()) throw new Error('插件入口代码为空')

  const requireFn: ModuleRequire = options.require ?? ((id: string) => {
    throw new Error(`插件内不支持 require("${id}")，请通过 api 参数访问客户端能力`)
  })

  const mod: CommonJsModule = { exports: {} }
  let factory: (...args: any[]) => any
  try {
    // 插件代码在运行时才存在（用户安装后落在 userData 下），无法静态编译，只能动态求值。
    // eslint-disable-next-line no-new-func, @typescript-eslint/no-implied-eval
    factory = new Function('module', 'exports', 'require', '__filename', '__dirname', code) as (...args: any[]) => any
  } catch (err) {
    throw new Error(`插件代码无法编译（语法错误）：${(err as Error).message}`)
  }
  try {
    factory(mod, mod.exports, requireFn, filename, dirname)
  } catch (err) {
    throw new Error(`插件代码执行失败：${(err as Error).message}`)
  }

  return normalizePluginExport(mod.exports)
}

/**
 * 规范化插件导出：
 *  - `module.exports = { setup, uninstall, onUpdate }` （推荐）
 *  - `exports.default = { ... }`（打包器 ESM→CJS 互操作时常见）
 *  - `module.exports = function (api) {}`（简写形式，等价于 setup）
 */
export function normalizePluginExport(exported: any): PluginModule {
  if (exported == null) throw new Error('插件未导出任何内容，请在入口文件使用 module.exports 导出 { setup }')
  let value = exported
  if (typeof value === 'object' && value.default != null) value = value.default
  if (typeof value === 'function') return { setup: value as PluginModule['setup'] }
  if (typeof value !== 'object') throw new Error(`插件导出类型非法：${typeof value}`)
  if (value.setup != null && typeof value.setup !== 'function') throw new Error('插件导出字段 setup 应为函数')
  if (value.uninstall != null && typeof value.uninstall !== 'function') throw new Error('插件导出字段 uninstall 应为函数')
  if (value.onUpdate != null && typeof value.onUpdate !== 'function') throw new Error('插件导出字段 onUpdate 应为函数')
  return value as PluginModule
}
