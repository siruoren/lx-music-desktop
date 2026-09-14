/**
 * repo-source-plugins —— lx-plugins 插件项目的插件入口。
 *
 * 本插件使用插件系统「不改动原代码即覆盖原功能」的全部能力：
 *
 *   1. api.patch(target, method, wrapper)
 *      运行时包装原函数。不调用 next 即完全覆盖；调用 next(...args) 即在原功能前后增强。
 *      禁用/卸载插件时宿主会统一回退，源码零残留。
 *   2. api.hooks.on / emit / intercept
 *      订阅生命周期与自定义拦截点。
 *   3. api.getData / setData
 *      插件私有持久化数据。
 *
 * 实际功能：音乐搜索「同源结果去重 + 累计统计」。
 *  - 同一个音乐源内部会返回重复条目（同名/同歌手/同专辑/同时长），本插件在
 *    musicSdk.searchMusic 的返回值上做一次稳定去重；
 *  - 只做「同一音乐源内部」去重，不跨源合并，避免丢失其它源里的可用结果；
 *  - 在插件管理页卸载后行为完全还原。
 *
 * 入口以 CommonJS 导出，构建脚本会把它包进单个 .lxplugin 文件：
 *   module.exports = { setup, uninstall, onUpdate }
 */
'use strict'

/** 累计统计（由插件私有存储读出/写回） */
let stats = { removedTotal: 0, lastRemoved: 0 }

/** 生成判重键：同名/同歌手/同专辑/同时长 视为同一首歌的重复返回 */
function dedupeKey(item) {
  return [
    item.name ?? '',
    item.singer ?? '',
    item.albumName ?? '',
    item.interval ?? '',
  ].join('\u0001')
}

/** 对单个音乐源的列表做稳定去重，保持原有顺序，返回 { list, removed } */
function dedupeList(list) {
  if (!Array.isArray(list)) return { list, removed: 0 }
  const seen = new Set()
  const result = []
  for (const item of list) {
    if (item == null) continue
    const key = dedupeKey(item)
    if (seen.has(key)) continue
    seen.add(key)
    result.push(item)
  }
  return { list: result, removed: list.length - result.length }
}

/** 对 searchMusic 的返回值（各音乐源结果数组）做同源去重 */
function dedupeSearchResult(sources) {
  if (!Array.isArray(sources)) return { sources, removed: 0 }
  let removed = 0
  const result = sources.map(source => {
    if (source == null || !Array.isArray(source.list)) return source
    const res = dedupeList(source.list)
    removed += res.removed
    return res.removed ? { ...source, list: res.list } : source
  })
  return { sources: result, removed }
}

module.exports = {
  /**
   * 插件被启用/加载时调用。
   * @param {object} api 插件 API（renderer 端为 RendererPluginApi）
   */
  setup(api) {
    stats = api.getData('stats', { removedTotal: 0, lastRemoved: 0 })

    const sdk = api.app && api.app.musicSdk
    if (!sdk || typeof sdk.searchMusic !== 'function') {
      api.logger.warn('未找到 musicSdk.searchMusic，跳过搜索增强')
      return
    }

    // ---- 覆盖/增强原功能：包装 musicSdk.searchMusic ----
    // wrapper 签名 (next, ...args)：next 为原实现（多层插件包装时为上一层包装）。
    api.patch(sdk, 'searchMusic', async(next, options) => {
      const result = await next(options)
      const { sources, removed } = dedupeSearchResult(result)
      if (removed > 0) {
        stats.removedTotal += removed
        stats.lastRemoved = removed
        api.setData('stats', stats)
        api.logger.info(`搜索结果去重：去除 ${removed} 条重复项（累计 ${stats.removedTotal} 条）`)
      }
      return sources
    })

    // ---- 生命周期钩子 ----
    api.hooks.on('app:ready', () => {
      api.logger.info(`已就绪：v${api.version}，累计去重 ${stats.removedTotal} 条`)
    })

    // ---- 自定义音乐源扩展点 ----
    // 需要接入自己的音乐源时，注册一个符合 musicSdk 源模块结构的对象即可：
    //   api.registerMusicSource('myid', '我的音乐源', { musicSearch: { search() {} }, ... })
    // 注册后的源会参与 musicSdk.init() 与 searchMusic()，卸载插件时自动移除。
    if (api.registerMusicSource) api.logger.info('registerMusicSource 可用，可按需注册自定义音乐源')
  },

  /** 插件被禁用/卸载时调用（宿主还会自动回退 patch 与 hooks） */
  uninstall() {
    console.log('[plugin:repo-source-plugins] 正在卸载，musicSdk 包装将由宿主还原')
  },

  /** 插件被更新后调用，oldVersion 为旧版本号 */
  onUpdate(oldVersion) {
    console.log(`[plugin:repo-source-plugins] 已从 v${oldVersion} 更新到 v1.0.0`)
  },
}
