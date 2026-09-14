/**
 * 插件管理相关 IPC 通道名（与主进程管理逻辑通信）。
 * 名称集中在此，避免散落各处；字符串常量，不依赖 @common/ipcNames。
 */

export const PLUGIN_IPC = {
  /** 列出已安装插件 -> PluginInfo[] */
  list: 'plugin:list',
  /** 返回可被 renderer 加载的插件清单（含入口文件名） -> {id,version,main}[] */
  rendererList: 'plugin:rendererList',
  /** 读取某插件入口源码（renderer 宿主加载 renderer 端插件用） -> string */
  readEntry: 'plugin:readEntry',

  /** 弹窗选择文件夹并安装（本地开发） -> PluginOperationResult */
  installPick: 'plugin:installPick',
  /** 从指定目录安装 -> PluginOperationResult */
  installPath: 'plugin:installPath',
  /** 弹窗选择单文件插件并安装 -> PluginOperationResult */
  installFilePick: 'plugin:installFilePick',
  /** 上传单文件插件内容并安装（参数 {fileName, content}） -> PluginOperationResult */
  installContent: 'plugin:installContent',

  /** 弹窗选择文件夹并更新某插件（本地开发） -> PluginOperationResult */
  updatePick: 'plugin:updatePick',
  /** 从指定目录更新某插件 -> PluginOperationResult */
  updatePath: 'plugin:updatePath',
  /** 弹窗选择单文件插件并更新某插件 -> PluginOperationResult */
  updateFilePick: 'plugin:updateFilePick',
  /** 上传单文件插件内容并更新某插件（参数 {id, fileName, content}） -> PluginOperationResult */
  updateContent: 'plugin:updateContent',

  /** 卸载插件（参数 {id}） -> PluginOperationResult */
  uninstall: 'plugin:uninstall',
  /** 启用（参数 {id}） -> PluginOperationResult */
  enable: 'plugin:enable',
  /** 禁用（参数 {id}） -> PluginOperationResult */
  disable: 'plugin:disable',
  /** 打开插件目录（参数 {id}） */
  openDir: 'plugin:openDir',

  /**
   * renderer 宿主上报某插件的实际加载结果（参数 {id, state, error?}）。
   * 主进程只加载 main 端插件，无从得知 renderer 端是否加载成功，
   * 因此由 renderer 侧回传，列表才能显示真实状态（已启用 / 出错）。
   */
  reportState: 'plugin:reportState',
} as const

/** renderer 宿主上报的加载状态 */
export type PluginRuntimeState = 'loaded' | 'unloaded' | 'error'

export type PluginIpcName = (typeof PLUGIN_IPC)[keyof typeof PLUGIN_IPC]
