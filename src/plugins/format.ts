/**
 * 单文件插件（.lxplugin）格式。
 *
 * ============================ 设计目标 ============================
 * 插件的“构建结果就是一个文件”，插件管理里直接上传该文件即可安装 / 更新，
 * 不需要用户手动解压文件夹。
 *
 * ============================ 文件结构 ============================
 *
 *   /*!lxplugin
 *   {"id":"repo-source-plugins","name":"repo-source-plugins","version":"1.0.0","platforms":["renderer"],"main":"index.js"}
 *   *\/
 *   ...插件模块代码（CommonJS）...
 *
 * 说明：
 *  - 文件开头的 `/*!lxplugin ... *\/` 横幅注释内嵌完整 plugin.json；
 *    它是合法 JS 注释，因此该文件本身依旧是一个可直接执行的 JS 模块，
 *    任何打包器（webpack / rollup / esbuild）都能用一句 banner 生成它。
 *  - 解析清单只做“文本解析 + JSON.parse”，不会执行插件代码，
 *    因此安装阶段（尚未启用）是安全的。
 *  - 模块代码需导出插件生命周期：`module.exports = { setup, uninstall, onUpdate }`；
 *    也兼容 `exports.default = { ... }`。
 *
 * 本文件不依赖任何第三方库（不引入 zip 等解压实现），保证易合入上游。
 */
import type { PluginManifest } from './types'
import { normalizeManifest } from './validate'

/** 单文件插件推荐扩展名 */
export const PLUGIN_FILE_EXT = '.lxplugin'
/** 允许上传的扩展名（含遗留的 .js 单文件） */
export const PLUGIN_ALLOWED_EXTS = [PLUGIN_FILE_EXT, '.js', '.cjs']
/** 单文件插件体积上限 */
export const MAX_PLUGIN_FILE_SIZE = 8 * 1024 * 1024
/** 安装后写入磁盘的入口文件名（若清单未指定 main） */
export const DEFAULT_ENTRY = 'index.js'

const BANNER_BEGIN = '/*!lxplugin'
const BANNER_END = '*/'

export interface ParsedPluginFile {
  manifest: PluginManifest
  /** 去掉横幅后的模块代码 */
  code: string
}

/** 判断文件名是否为受支持的单文件插件 */
export function isPluginFileName(fileName: string): boolean {
  const lower = String(fileName || '').toLowerCase()
  return PLUGIN_ALLOWED_EXTS.some(ext => lower.endsWith(ext))
}

/**
 * 解析单文件插件内容。
 * @throws 格式非法时抛出异常（附带可读的提示）
 */
export function parsePluginFile(content: unknown): ParsedPluginFile {
  if (typeof content !== 'string' || !content.trim()) throw new Error('插件文件内容为空')
  if (content.length > MAX_PLUGIN_FILE_SIZE) {
    throw new Error(`插件文件过大：${formatSize(content.length)}（上限 ${formatSize(MAX_PLUGIN_FILE_SIZE)}）`)
  }

  // 允许 BOM 与前置空白
  const text = content.replace(/^\uFEFF/, '')
  const begin = text.indexOf(BANNER_BEGIN)
  if (begin === -1 || text.slice(0, begin).trim() !== '') {
    throw new Error(
      `未找到插件清单横幅（文件需以 "${BANNER_BEGIN}" 开头）。` +
      '请使用插件构建脚本生成 .lxplugin 文件（如 lx-plugins/repo-source-plugins/build.js），或手工在文件顶部添加该横幅。',
    )
  }
  const jsonStart = begin + BANNER_BEGIN.length
  const end = text.indexOf(BANNER_END, jsonStart)
  if (end === -1) throw new Error('插件清单横幅未闭合（缺少 "*" + "/"）')

  const jsonText = text.slice(jsonStart, end).trim()
  let raw: any
  try {
    raw = JSON.parse(jsonText)
  } catch (err) {
    throw new Error(`插件清单 JSON 解析失败：${(err as Error).message}`)
  }
  const manifest = normalizeManifest(raw)

  const code = text.slice(end + BANNER_END.length).replace(/^\s*\n/, '')
  if (!code.trim()) throw new Error('插件文件不包含任何模块代码')

  return { manifest, code }
}

/** 生成单文件插件内容（供构建脚本 / 导出功能复用） */
export function buildPluginFile(manifest: PluginManifest, code: string): string {
  const json = JSON.stringify(manifest, null, 2)
  return `${BANNER_BEGIN}\n${json}\n${BANNER_END}\n${code}`
}

/** 依据插件文件名推断插件名（仅用于错误提示，不参与安装） */
export function suggestPluginName(fileName: string): string {
  const base = String(fileName || '').replace(/\\/g, '/').split('/').pop() ?? ''
  return base.replace(/\.[^.]+$/, '')
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`
}
