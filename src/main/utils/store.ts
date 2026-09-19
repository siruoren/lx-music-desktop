// import { writeFileSync } from 'atomically'
import { dialog, shell } from 'electron'
import path from 'node:path'
import fs from 'node:fs'
import { log } from '@common/utils'

type Stores = Record<string, Store>

const stores: Stores = {}


class Store {
  private readonly filePath: string
  private readonly dirPath: string
  private store: Record<string, any>
  /** 异步写入是否进行中（见 writeFileAsync） */
  private writing = false
  /** 异步写入进行中又有新改动时置位，写入完成后会再写一次以保证最终一致 */
  private dirty = false

  private writeFile() {
    const tempPath = this.filePath + '.' + Math.random().toString().substring(2, 10) + '.temp'
    try {
      fs.writeFileSync(tempPath, JSON.stringify(this.store, null, '\t'), 'utf8')
    } catch (err: any) {
      if (err.code === 'ENOENT') {
        fs.mkdirSync(this.dirPath, { recursive: true })
        fs.writeFileSync(tempPath, JSON.stringify(this.store, null, '\t'), 'utf8')
      } else throw err
    }
    fs.renameSync(tempPath, this.filePath)
  }

  /**
   * 非阻塞的原子写入（临时文件 + rename），用于“高频写入”场景（如批量导入自定义源）。
   * 与 writeFile 的区别：
   *  - 实际写盘在下一个宏任务里进行，且不占用主线程做同步 I/O，避免批量导入时
   *    每个源都同步重写整个 userApi.json 把主线程（连同渲染进程）卡死；
   *  - 多次连续调用会被合并：writing 期间的新改动只置 dirty，写完后再补一次，
   *    保证最终落盘的是最新内存状态；
   *  - 写入用临时文件 + rename（原子），中途进程被杀也只会留下临时文件，不会产出半截的正式文件。
   */
  writeFileAsync() {
    if (this.writing) {
      this.dirty = true
      return
    }
    this.writing = true
    void this.doWriteFile()
      .catch((err: any) => log.error(err))
      .finally(() => {
        this.writing = false
        if (this.dirty) {
          this.dirty = false
          this.writeFileAsync()
        }
      })
  }

  private async doWriteFile(): Promise<void> {
    const tempPath = this.filePath + '.' + process.pid + '.' + Math.random().toString(36).slice(2, 10) + '.tmp'
    const data = JSON.stringify(this.store, null, '\t')
    try {
      await fs.promises.writeFile(tempPath, data, 'utf8')
    } catch (err: any) {
      if (err.code === 'ENOENT') {
        fs.mkdirSync(this.dirPath, { recursive: true })
        await fs.promises.writeFile(tempPath, data, 'utf8')
      } else throw err
    }
    await fs.promises.rename(tempPath, this.filePath)
  }

  /** 同步强制落盘（优雅退出时调用，确保异步写入的尾差不丢失） */
  flush() {
    try {
      this.writeFile()
    } catch (err: any) {
      log.error(err)
    }
  }

  constructor(filePath: string, clearInvalidConfig: boolean = false) {
    this.filePath = filePath
    this.dirPath = path.dirname(this.filePath)

    let store: Record<string, any>
    if (fs.existsSync(this.filePath)) {
      if (clearInvalidConfig) {
        try {
          store = JSON.parse(fs.readFileSync(this.filePath, 'utf8'))
        } catch {
          store = {}
        }
      } else store = JSON.parse(fs.readFileSync(this.filePath, 'utf8'))
    } else store = {}

    if (typeof store != 'object') {
      if (clearInvalidConfig) store = {}
      else throw new Error('parse data error: ' + String(store))
    }
    this.store = store
  }

  get<Value>(key: string): Value {
    return this.store[key]
  }

  has(key: string): boolean {
    return key in this.store
  }

  set(key: string, value: any) {
    this.store[key] = value
    this.writeFile()
  }

  /** 同 set，但用非阻塞的异步写盘（见 writeFileAsync） */
  setAsync(key: string, value: any) {
    this.store[key] = value
    this.writeFileAsync()
  }

  override(value: Record<string, any>) {
    this.store = value
    this.writeFile()
  }
}

/**
 * 获取 Store 对象
 * @param name store 名
 * @param isIgnoredError 是否忽略错误
 * @param isShowErrorAlert=true 是否显示错误弹窗
 * @returns Store
 */
export default (name: string, isIgnoredError = true, isShowErrorAlert = true): Store => {
  if (stores[name]) return stores[name]
  let store: Store
  const storePath = path.join(global.lxDataPath, name + '.json')
  try {
    store = stores[name] = new Store(storePath, false)
  } catch (err: any) {
    const error = err as Error
    log.error(error)

    if (!isIgnoredError) throw error


    const backPath = storePath + '.bak'
    fs.renameSync(storePath, backPath)
    if (isShowErrorAlert) {
      dialog.showMessageBoxSync({
        type: 'error',
        message: name + ' data load error',
        detail: `We have helped you back up the old ${name} file to: ${backPath}\nYou can try to repair and restore it manually\n\nError detail: ${error.message}`,
      })
      shell.showItemInFolder(backPath)
    }


    store = new Store(storePath, true)
  }
  return store
}

export {
  Store,
}
