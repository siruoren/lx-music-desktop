/**
 * 插件清单的“纯校验”逻辑（不依赖 fs，main / renderer 均可安全引用）。
 *
 * 与 manifest.ts 的分工：
 *  - 本文件：把任意对象规范化/校验为 PluginManifest，并做客户端版本兼容性判断；
 *  - manifest.ts：负责从磁盘读取 plugin.json，然后复用本文件的校验。
 * 这样 renderer 侧（如插件管理 UI 预校验上传的文件）引用本文件时不会牵连 node 内置模块。
 */
import type { PluginManifest, PluginPlatform } from './types'
import { satisfies } from './semver'

/** 读取客户端版本（renderer 侧可能没有 process，做安全兜底） */
function readAppVersion(): string {
  if (typeof process === 'undefined') return ''
  return process.versions?.app ?? ''
}

export function getAppVersion(): string {
  return readAppVersion()
}

/** 插件 id 允许的字符：避免出现路径分隔符等导致目录穿越 / 非法路径 */
const VALID_ID = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/

/**
 * 校验插件 id 是否合法（同时用于防御目录穿越，因为 id 会作为目录名使用）。
 * @throws 不合法时抛出异常
 */
export function assertSafePluginId(id: unknown): asserts id is string {
  if (typeof id !== 'string' || !id) throw new Error('插件 id 不能为空')
  if (id.length > 128) throw new Error(`插件 id 过长：${id.length} 字符（上限 128）`)
  if (!VALID_ID.test(id)) {
    throw new Error(`插件 id 非法（仅允许字母、数字、.、_、-，且以字母或数字开头）：${id}`)
  }
}

/** 校验入口文件名（必须是不含路径分隔符的简单文件名） */
export function assertSafeEntryName(main: unknown): asserts main is string {
  if (typeof main !== 'string' || !main) throw new Error('插件入口文件名（main）不能为空')
  if (/[/\\]/.test(main) || main === '.' || main === '..') {
    throw new Error(`插件入口文件名（main）不能包含路径分隔符：${main}`)
  }
  if (!/\.(js|cjs|mjs)$/.test(main)) {
    throw new Error(`插件入口文件名（main）必须以 .js/.cjs/.mjs 结尾：${main}`)
  }
}

/**
 * 将任意对象规范化为插件清单（做完整字段校验）。
 * @throws 校验失败时抛出异常
 */
export function normalizeManifest(raw: any): PluginManifest {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('插件清单内容非法（应为 JSON 对象）')
  assertSafePluginId(raw.id)
  if (!raw.name || typeof raw.name !== 'string') throw new Error('插件清单缺少 name')
  if (!raw.version || typeof raw.version !== 'string') throw new Error('插件清单缺少 version')
  if (!/^\d+(\.\d+)*([+-][0-9A-Za-z.-]+)?$/.test(raw.version.trim())) {
    throw new Error(`插件清单 version 格式非法：${raw.version}（应形如 1.0.0）`)
  }

  const main = raw.main ?? 'index.js'
  assertSafeEntryName(main)

  const platforms: PluginPlatform[] = Array.isArray(raw.platforms) && raw.platforms.length
    ? raw.platforms
    : ['renderer']
  for (const p of platforms) {
    if (p !== 'main' && p !== 'renderer') throw new Error(`插件清单 platforms 含未知值：${String(p)}`)
  }
  if (raw.engines != null && typeof raw.engines !== 'object') throw new Error('插件清单 engines 应为对象')

  return {
    id: raw.id,
    name: raw.name,
    version: raw.version,
    description: raw.description,
    author: raw.author,
    homepage: raw.homepage,
    main,
    engines: raw.engines,
    platforms,
  }
}

/**
 * 校验插件与当前客户端是否兼容。
 * @returns 不兼容原因；null 表示兼容
 */
export function checkCompatibility(manifest: PluginManifest): string | null {
  const req = manifest.engines?.app
  const appVersion = readAppVersion()
  if (req && appVersion && !satisfies(appVersion, req)) {
    return `需要客户端版本 ${req}，当前为 ${appVersion}`
  }
  return null
}
