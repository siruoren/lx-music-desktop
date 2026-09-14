/**
 * 插件系统 - 公共类型定义
 *
 * 该目录（src/plugins）为新增目录，不与上游任何文件冲突；后续合入 lx-music-desktop
 * 官方更新时，只需把本目录整体带入，并保证 4 个文件里带 `Plugin Manager` 标记的侵入点存在即可：
 *   src/main/index.ts、src/renderer/main.ts、
 *   src/renderer/views/Setting/index.vue、src/renderer/utils/musicSdk/index.js
 *
 * 插件分发形态：
 *  - 单文件（推荐）：`.lxplugin`，清单内嵌于文件头的横幅注释，构建产物就是一个文件，
 *    插件管理页可直接上传安装 / 更新（见 format.ts）。
 *  - 文件夹（兼容）：目录内含 plugin.json 与入口文件，便于本地开发调试。
 */
import type { HookBus } from './hookBus'

/** 插件运行的进程端 */
export type PluginPlatform = 'main' | 'renderer'

/** 插件状态 */
export type PluginStatus =
  | 'enabled' // 已启用
  | 'disabled' // 已禁用
  | 'error' // 加载/执行出错
  | 'incompatible' // 与当前客户端版本不兼容

/** 插件清单（plugin.json） */
export interface PluginManifest {
  /** 全局唯一 id，建议使用反向域名（如 com.yourname.myplugin） */
  id: string
  /** 展示名称 */
  name: string
  /** 语义化版本号，如 1.0.0 */
  version: string
  /** 描述 */
  description?: string
  /** 作者 */
  author?: string
  /** 主页 / 仓库地址 */
  homepage?: string
  /** 入口文件，相对插件目录，默认 index.js */
  main?: string
  /** 要求的最低客户端版本，如 >=2.0.0 */
  engines?: {
    app?: string
  }
  /** 运行端，默认 ['renderer'] */
  platforms?: PluginPlatform[]
}

/** 管理端返回给 UI 的插件信息 */
export interface PluginInfo {
  id: string
  name: string
  version: string
  description?: string
  author?: string
  homepage?: string
  platforms: PluginPlatform[]
  enabled: boolean
  status: PluginStatus
  /** 出错时的说明 */
  error?: string
  /** 插件目录 */
  dir: string
}

/** 插件安装/更新结果 */
export interface PluginOperationResult {
  success: boolean
  id?: string
  message?: string
}

/** 单个插件的生命周期导出（入口文件 default export） */
export interface PluginModule {
  /** 插件被加载/启用时调用，传入插件 API */
  setup?: (api: PluginApi) => void | Promise<void>
  /** 插件被卸载/禁用时调用（用于清理） */
  uninstall?: () => void | Promise<void>
  /** 插件被更新后调用，oldVersion 为旧版本号 */
  onUpdate?: (oldVersion: string) => void | Promise<void>
}

/**
 * 提供给插件的 API（host 端根据进程注入不同能力）。
 * 这是插件“覆盖/修改原代码功能”的主要手段：
 *  - hooks：事件钩子（监听/干预生命周期与原事件）
 *  - patch：包装任意原函数（运行时覆盖原功能，无需改动源码）
 *  - registerMusicSource：声明式注册音乐源
 */
export interface PluginApi {
  /** 插件 id */
  id: string
  /** 插件版本 */
  version: string
  /** 插件目录 */
  dir: string
  /** 运行端 */
  platform: PluginPlatform
  /** 日志 */
  logger: {
    info: (...args: any[]) => void
    warn: (...args: any[]) => void
    error: (...args: any[]) => void
  }
  /** 钩子总线 */
  hooks: HookBus
  /** 运行时包装原函数（覆盖原功能）。wrapper(next, ...args)，next 为原实现 */
  patch: (target: any, method: string, wrapper: (next: (...a: any[]) => any, ...args: any[]) => any) => void
  /** 取消包装 */
  unpatch: (target: any, method: string, wrapper?: (next: (...a: any[]) => any, ...args: any[]) => any) => void
  /** 读取插件私有持久化数据 */
  getData: <T = any>(key: string, defaultValue?: T) => T
  /** 写入插件私有持久化数据 */
  setData: (key: string, value: any) => void
  /** 客户端全局对象（main 端为 global.lx，renderer 端为 window.lx） */
  app: any
}

/** renderer 端独有的插件 API（注册音乐源等 UI/渲染相关能力） */
export interface RendererPluginApi extends PluginApi {
  /** 注册/覆盖一个音乐源，module 需符合 musicSdk 源模块结构（含 musicSearch/songList 等） */
  registerMusicSource: (id: string, name: string, module: any) => void
  /** 注销音乐源 */
  unregisterMusicSource: (id: string) => void
}
