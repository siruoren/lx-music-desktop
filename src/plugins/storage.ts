/**
 * 插件启用状态持久化（enabled.json）。
 * 仅记录哪些插件被启用，避免每次启动全量加载；卸载后自动清除。
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs'
import { dirname, join } from 'path'

export class EnabledState {
  private readonly file: string
  private state: Record<string, boolean | undefined> = {}

  constructor(pluginsDir: string) {
    this.file = join(pluginsDir, 'enabled.json')
    this.load()
  }

  private load(): void {
    try {
      if (existsSync(this.file)) {
        this.state = JSON.parse(readFileSync(this.file, 'utf-8'))
      }
    } catch {
      this.state = {}
    }
  }

  private save(): void {
    try {
      mkdirSync(dirname(this.file), { recursive: true })
      writeFileSync(this.file, JSON.stringify(this.state, null, 2), 'utf-8')
    } catch (err) {
      console.error('[plugin] 保存启用状态失败：', err)
    }
  }

  /** 未记录时默认启用（只有显式禁用过的插件才返回 false） */
  isEnabled(id: string): boolean {
    return this.state[id] ?? true
  }

  setEnabled(id: string, enabled: boolean): void {
    this.state[id] = enabled
    this.save()
  }

  remove(id: string): void {
    const rest: Record<string, boolean | undefined> = {}
    for (const key of Object.keys(this.state)) {
      if (key !== id) rest[key] = this.state[key]
    }
    this.state = rest
    this.save()
  }
}

/**
 * 插件配置持久化。
 *
 * 每个插件的配置**单独保存在插件自己的目录**：`<插件目录>/config.json`。
 * 这样插件彼此隔离，也不会污染主程序的设置（appSetting）。
 * 启动时由插件自行读取并应用，因此配置改完在下一次启动依然生效。
 */
export class PluginConfigStore {
  constructor(private readonly pluginsDir: string) {}

  private fileOf(id: string): string {
    return join(this.pluginsDir, id, 'config.json')
  }

  /** 读取某插件的全部配置（不存在或损坏时返回空对象） */
  read(id: string): Record<string, any> {
    try {
      const file = this.fileOf(id)
      if (!existsSync(file)) return {}
      const json = JSON.parse(readFileSync(file, 'utf-8'))
      return json && typeof json === 'object' && !Array.isArray(json) ? json : {}
    } catch (err) {
      console.error(`[plugin] 读取插件配置失败 ${id}:`, err)
      return {}
    }
  }

  /** 合并写入某插件配置，返回写入后的完整配置 */
  patch(id: string, patch: Record<string, any>): Record<string, any> {
    const next = Object.assign(this.read(id), patch ?? {})
    try {
      const dir = join(this.pluginsDir, id)
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
      writeFileSync(this.fileOf(id), JSON.stringify(next, null, 2), 'utf-8')
    } catch (err) {
      console.error(`[plugin] 写入插件配置失败 ${id}:`, err)
    }
    return next
  }
}
