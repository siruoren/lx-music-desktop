/**
 * 插件系统 - 公共类型定义
 *
 * 该目录（src/plugins）为新增目录，不与上游任何文件冲突；后续合入 lx-music-desktop
 * 官方更新时，只需把本目录整体带入，并保证 6 处带 `Plugin Manager` 标记的侵入点存在即可：
 *   src/main/index.ts、src/main/modules/winMain/main.ts、src/renderer/main.ts、
 *   src/renderer/utils/musicSdk/index.js、src/renderer/utils/request.js、
 *   插件管理 UI 入口（src/renderer/router.ts + components/layout/Aside/NavBar.vue + components/layout/Icons.vue，
 *   页面体为 src/plugins/ui/Plugins.vue，内容组件 SettingPlugins.vue）
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
  /**
   * 插件配置被修改后调用（宿主写入 config.json 之后触发）。
   * 用于让插件把新配置真正应用起来（例如重建代理 agent）。
   */
  onConfigChange?: (config: Record<string, any>) => void | Promise<void>
  /** 插件设置面板上的按钮被点击时调用（action 为字段上声明的动作名） */
  onSettingsAction?: (action: string, config: Record<string, any>) => void | Promise<void>
}

/**
 * 插件设置面板中的单个字段（声明式）。
 * 宿主统一渲染成控件，插件无需自带 Vue 组件 —— 这样插件构建产物依旧是单个文件，
 * 也避免插件代码进入 webpack 编译链（历史上 .vue 里的 TS 语法会让构建失败）。
 */
export interface PluginSettingField {
  /** 字段类型 */
  type: 'switch' | 'text' | 'password' | 'number' | 'textarea' | 'info' | 'button' | 'buttons' | 'list' | 'divider'
  /** 配置键（switch / text / password / number / textarea 必填） */
  key?: string
  /** 展示名称 */
  label?: string
  /** 输入框占位提示 */
  placeholder?: string
  /** 控件下方的小字说明 */
  tip?: string
  /** 默认值（配置里没有该键时使用） */
  default?: any
  /** 是否禁用 */
  disabled?: boolean
  /** type=button 时点击触发的动作名（透传给 module.onSettingsAction） */
  action?: string
  /**
   * type=buttons 时的按钮组：**同一行水平排列**，每个按钮各有自己的动作名。
   * 相比写多个 type=button 字段（会各占一行、纵向堆叠），它适合「导入 / 移除」这类成对操作。
   */
  buttons?: PluginSettingButton[]
  /** type=info 时的文本；传函数则每次渲染求值，便于显示实时状态 */
  text?: string | (() => string)
  /** type=list 时的条目；传函数则每次渲染求值 */
  items?: () => Array<{ name?: string, desc?: string, status?: string }>
  /** 控件右侧的附加文字（如「上次更新：…」）；传函数则每次渲染求值 */
  suffix?: string | (() => string)
}

/** type=buttons 字段里的单个按钮 */
export interface PluginSettingButton {
  /** 按钮文字 */
  label: string
  /** 点击触发的动作名（透传给 module.onSettingsAction） */
  action: string
  /** 是否禁用该按钮 */
  disabled?: boolean
}

/** 插件设置面板描述（由插件在 setup 时通过 api.registerSettings 注册） */
export interface PluginSettingsSpec {
  /** 面板标题，默认使用插件名 */
  title?: string
  /** 字段列表，按顺序渲染 */
  fields: PluginSettingField[]
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
  /**
   * 声明 Chromium 会话代理（**仅 main 端可用**）。
   *
   * `<audio>`/`<img>` 等由 Chromium 直接发起的请求（音乐播放、封面加载）不经过
   * `src/renderer/utils/request.js`，只接管 Node 的 http.Agent 影响不到它们；
   * 通过本方法把代理设到**会话**上，播放才会真正走代理。
   *
   * @param rules Electron 的 proxyRules 字符串，如 `'socks5://127.0.0.1:1080'`、
   *   `'http://127.0.0.1:12345'`（指向插件自建的本地桥）；传 `null` 撤销接管、
   *   回到 app 自身的网络代理设置。
   */
  setSessionProxy?: (rules: string | null) => void
  /**
   * 主进程 electron 模块（**仅 main 端可用**）。
   * 用于构造 TouchBar 等原生 GUI 对象：
   *   `const { TouchBar, TouchBarButton, TouchBarLabel, TouchBarSpacer } = api.electron`
   */
  electron?: any
  /**
   * 设置主窗口的 Touch Bar（**仅 main 端可用**，仅 macOS 生效）。
   * 传入用 `api.electron.TouchBar` 构造的实例；传 `null` 移除。
   * 窗口尚未创建时挂起、窗口就绪后自动应用，并在窗口重建后重新应用。
   */
  setTouchBar?: (touchBar: any) => void
  /**
   * 向 renderer 发送播放控制指令（**仅 main 端可用**）。
   * action 同任务栏按钮：`play` / `pause` / `prev` / `next` / `collect` / `unCollect` / ...
   */
  controlPlayer?: (action: string, data?: any) => void
}

/** renderer 端独有的插件 API（注册音乐源、设置面板等 UI/渲染相关能力） */
export interface RendererPluginApi extends PluginApi {
  /** 注册/覆盖一个音乐源，module 需符合 musicSdk 源模块结构（含 musicSearch/songList 等） */
  registerMusicSource: (id: string, name: string, module: any) => void
  /** 注销音乐源 */
  unregisterMusicSource: (id: string) => void
  /**
   * 注册本插件的设置面板，会出现在插件管理页（侧边栏「插件管理」）中该插件的「设置」按钮里。
   * 面板上的字段用声明式描述，由宿主渲染，插件无需自带 Vue 组件。
   */
  registerSettings: (spec: PluginSettingsSpec) => void
  /** 读取本插件配置（保存在插件目录 config.json，启动时自动载入，改完即生效） */
  getConfig: <T = Record<string, any>>() => T
  /** 合并写入本插件配置（持久化到插件目录 config.json，并触发 module.onConfigChange） */
  setConfig: (patch: Record<string, any>) => void
}
