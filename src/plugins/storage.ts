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
