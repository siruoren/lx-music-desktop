/**
 * 插件清单读取（磁盘侧）。
 *
 * 目录形态的插件目录下必须包含 plugin.json；单文件形态（.lxplugin）的清单
 * 内嵌在文件头的横幅注释里，由 format.ts 解析。两者的字段校验共用 validate.ts。
 */
import { existsSync, readFileSync } from 'fs'
import { join } from 'path'
import { normalizeManifest } from './validate'
import type { PluginManifest } from './types'

// 纯校验能力统一从本模块转出，调用方无需关心内部拆分
export {
  assertSafePluginId,
  assertSafeEntryName,
  checkCompatibility,
  getAppVersion,
  normalizeManifest,
} from './validate'

/** 读取并校验清单；出错抛出异常 */
export function readManifest(pluginDir: string): PluginManifest {
  const manifestPath = join(pluginDir, 'plugin.json')
  if (!existsSync(manifestPath)) {
    throw new Error(`缺少 plugin.json：${manifestPath}`)
  }
  let raw: any
  try {
    raw = JSON.parse(readFileSync(manifestPath, 'utf-8'))
  } catch (err) {
    throw new Error(`plugin.json 解析失败：${(err as Error).message}`)
  }
  return normalizeManifest(raw)
}
