/**
 * 插件启用状态持久化（enabled.json）。
 * 仅记录哪些插件被启用，避免每次启动全量加载；卸载后自动清除。
 */
import { existsSync, readFileSync, mkdirSync, renameSync, openSync, writeSync, closeSync, fsyncSync } from 'fs'
import { dirname, join } from 'path'

/**
 * 原子写入：先写临时文件（含 fsync 落盘），再用 rename 替换目标文件。
 *
 * 为什么必须原子：config.json / enabled.json 是单文件、无事务的 JSON。
 * 若直接用 writeFileSync 覆盖目标文件，进程在“截断 → 写完”之间被强杀
 * （例如批量导入卡死后用户强制退出）会导致目标文件只剩半截，下次启动
 * JSON.parse 失败 → 读不到配置 → 表现为“设置项没了”。
 * 临时文件写到一半只会影响临时文件本身，rename 在同文件系统内是原子操作，
 * 因此目标文件要么是新内容、要么是旧内容，绝不会是半截。
 */
export function atomicWrite(filePath: string, data: string): void {
  const dir = dirname(filePath)
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  const tmp = `${filePath}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`
  const fd = openSync(tmp, 'w')
  try {
    writeSync(fd, data)
    // fsync 确保内容真正落盘，避免操作系统写缓存导致“文件已 rename 但数据未落盘”的假成功
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
  renameSync(tmp, filePath)
}

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
      atomicWrite(this.file, JSON.stringify(this.state, null, 2))
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

  /** 读取某插件的全部配置（不存在或损坏时尝试从 .bak 恢复，仍失败则返回空对象） */
  read(id: string): Record<string, any> {
    const file = this.fileOf(id)
    const tryParse = (path: string): Record<string, any> | null => {
      try {
        if (!existsSync(path)) return null
        const json = JSON.parse(readFileSync(path, 'utf-8'))
        return json && typeof json === 'object' && !Array.isArray(json) ? json : null
      } catch {
        return null
      }
    }
    const parsed = tryParse(file)
    if (parsed) return parsed
    // 主文件损坏：尝试用上一次的 .bak 救回，救不回就当空配置（至多丢失本插件设置）
    const bak = `${file}.bak`
    const recovered = tryParse(bak)
    if (recovered) {
      try {
        atomicWrite(file, JSON.stringify(recovered, null, 2))
        console.warn(`[plugin] 插件配置已损坏，已从备份恢复：${id}`)
        return recovered
      } catch {
        /* ignore */
      }
    }
    if (existsSync(file)) console.error(`[plugin] 读取插件配置失败（文件损坏）${id}`)
    return {}
  }

  /** 合并写入某插件配置，返回写入后的完整配置 */
  patch(id: string, patch: Record<string, any>): Record<string, any> {
    const next = Object.assign(this.read(id), patch ?? {})
    try {
      // 写之前先把当前（尚且有效的）内容备份一份，作为读取失败时的兜底
      const file = this.fileOf(id)
      if (existsSync(file)) {
        try {
          renameSync(file, `${file}.bak`)
        } catch {
          /* ignore */
        }
      }
      atomicWrite(file, JSON.stringify(next, null, 2))
    } catch (err) {
      console.error(`[plugin] 写入插件配置失败 ${id}:`, err)
    }
    return next
  }
}
