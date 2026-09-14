/**
 * repo-source-plugins —— 远程自定义源批量导入 / 自动更新 + 搜索结果增强。
 *
 * 一、远程自定义源（本插件的主要功能）
 *   1. 在「设置 → 插件管理 → repo-source-plugins → 设置」里填写**远程列表文件地址**；
 *      列表文件是纯文本，每行一个自定义源 js 的地址（以 # 或 // 开头的行会被忽略）。
 *   2. 点「立即导入 / 更新」即从列表文件里逐行取出 js 地址并批量导入到客户端的
 *      「自定义源」中 —— 因此它们会出现在 设置 → 基本设置 → 自定义源 列表里，可以勾选。
 *   3. 开启「自动更新」后，每次启动客户端都会重新拉取列表并更新已导入的源；
 *      勾选项后面会显示最近一次更新的时间。
 *   4. 已导入的源记录在本插件自己的账本里，配置与账本都保存在**插件目录**的
 *      config.json（<插件目录>/config.json），与 app 自身设置完全隔离。
 *
 *   实现要点：客户端「自定义源」的导入接口每次都会生成新的源 id，无法原地覆盖，
 *   所以更新某个源时是「先移除旧 id、再导入新内容」；若该源原本处于被选中状态，
 *   会自动把选中项切到新 id，避免用户的勾选被清掉。
 *
 * 二、搜索结果增强（可开关）
 *   包装 musicSdk.searchMusic，对同一个音乐源内部的重复条目做稳定去重。
 *   这一段用来演示插件的「运行时覆盖原功能」能力（api.patch）。
 *
 * 入口以 CommonJS 导出，构建脚本会把它包进单个 .lxplugin 文件：
 *   module.exports = { setup, uninstall, onUpdate, onConfigChange, onSettingsAction }
 */
'use strict'

const http = require('http')
const https = require('https')
const crypto = require('crypto')

/** 下载超时（毫秒） */
const FETCH_TIMEOUT = 20000
/** 启动自动更新的延迟：等 app 自身的初始化（含自定义源列表载入）跑完，避免相互覆盖 */
const STARTUP_DELAY = 2000

/** 默认配置（全部在插件设置面板里可改） */
const DEFAULT_CONFIG = {
  /** 远程列表文件地址：每行一个自定义源 js 的地址 */
  listUrl: '',
  /** 每次启动客户端时自动更新已导入的远程源 */
  autoUpdate: true,
  /** 搜索结果同源去重 */
  dedupe: true,
  /** 上次更新时间（毫秒时间戳，0 表示从未更新） */
  lastUpdateAt: 0,
  /** 上次更新的结果说明 */
  lastResult: '',
  /** 已导入的远程源账本：[{ url, apiId, name, version, hash, updatedAt }] */
  sources: [],
}

/** setup 时写入，供 module 上的生命周期回调使用 */
let ctx = null

/** ============================ 小工具 ============================ */

function formatTime(ts) {
  if (!ts) return '—'
  const d = new Date(ts)
  const p = n => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

function hashOf(text) {
  return crypto.createHash('sha1').update(text, 'utf8').digest('hex')
}

/** 从自定义源脚本的文件头注释块里取一个 @字段 */
function readScriptInfo(script, key) {
  const block = /^\/\*[\s\S]+?\*\//.exec(String(script).replace(/^\uFEFF/, ''))
  if (!block) return ''
  const rxp = new RegExp(`^\\s*\\*\\s?@${key}\\s+(.+)$`, 'm')
  const m = rxp.exec(block[0])
  return m ? m[1].trim() : ''
}

/** 解析列表文件：每行一个地址，忽略空行与 # / // 注释行 */
function parseList(text) {
  const urls = []
  const seen = new Set()
  for (const raw of String(text).replace(/^\uFEFF/, '').split(/\r?\n/)) {
    const line = raw.trim()
    if (!line) continue
    if (line.startsWith('#') || line.startsWith('//')) continue
    if (seen.has(line)) continue
    seen.add(line)
    urls.push(line)
  }
  return urls
}

/**
 * 下载文本（跟随重定向）。
 * 说明：这里用 Node 内置的 http/https，因此**不经过**音乐源的请求链
 * （也就是说 socks_proxy 等插件不会作用于本插件的下载）。
 */
function fetchText(url, redirects) {
  return new Promise((resolve, reject) => {
    let target
    try {
      target = new URL(url)
    } catch {
      reject(new Error(`地址不合法：${url}`))
      return
    }
    const mod = target.protocol === 'https:' ? https : http
    const req = mod.get(target, {
      headers: {
        'User-Agent': 'lx-music-desktop/plugin:repo-source-plugins',
        Accept: 'text/plain, application/javascript, */*',
      },
    }, res => {
      const code = res.statusCode || 0
      const location = res.headers.location
      if (code >= 300 && code < 400 && location) {
        res.resume()
        if (redirects <= 0) {
          reject(new Error(`重定向次数过多：${url}`))
          return
        }
        let next
        try {
          next = new URL(location, url).toString()
        } catch {
          reject(new Error(`重定向地址不合法：${location}`))
          return
        }
        resolve(fetchText(next, redirects - 1))
        return
      }
      if (code !== 200) {
        res.resume()
        reject(new Error(`HTTP ${code}`))
        return
      }
      const chunks = []
      res.on('data', chunk => { chunks.push(chunk) })
      res.on('end', () => { resolve(Buffer.concat(chunks).toString('utf8')) })
      res.on('error', reject)
    })
    req.setTimeout(FETCH_TIMEOUT, () => { req.destroy(new Error(`下载超时（${FETCH_TIMEOUT}ms）`)) })
    req.on('error', reject)
  })
}

/** ============================ 搜索结果去重 ============================ */

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

/** ============================ 插件生命周期 ============================ */

module.exports = {
  /**
   * 插件被启用/加载时调用。
   * @param {object} api 插件 API（renderer 端为 RendererPluginApi）
   */
  setup(api) {
    // 配置与账本都在插件目录的 config.json 里（api.getConfig/setConfig）
    const state = Object.assign({}, DEFAULT_CONFIG, api.getConfig())
    if (!Array.isArray(state.sources)) state.sources = []
    let stats = api.getData('stats', { removedTotal: 0, lastRemoved: 0 })
    let running = false

    const persist = () => {
      api.setConfig({
        listUrl: state.listUrl,
        autoUpdate: state.autoUpdate,
        dedupe: state.dedupe,
        lastUpdateAt: state.lastUpdateAt,
        lastResult: state.lastResult,
        sources: state.sources,
      })
    }

    /** 客户端「自定义源」能力的桥（由 renderer 宿主暴露在 window.lx.plugins.userApi） */
    const bridge = () => {
      const plugins = api.app && api.app.plugins
      return (plugins && plugins.userApi) || null
    }

    /** 导入 / 更新列表文件里的全部远程源 */
    const updateAll = async(reason) => {
      if (running) return
      const userApi = bridge()
      if (!userApi) {
        state.lastResult = '当前客户端未提供「自定义源」接口，无法导入'
        persist()
        return
      }
      if (!state.listUrl) {
        state.lastResult = '还没有填写远程列表文件地址'
        persist()
        return
      }
      running = true
      state.lastResult = `正在更新（${reason}）…`
      persist()
      try {
        const listText = await fetchText(state.listUrl, 5)
        const urls = parseList(listText)
        if (!urls.length) {
          state.lastResult = `列表文件里没有可用的 js 地址：${state.listUrl}`
          return
        }
        const prevMap = new Map(state.sources.map(item => [item.url, item]))
        const now = Date.now()
        const lines = []
        const next = []
        let imported = 0
        let unchanged = 0
        let failed = 0

        for (const url of urls) {
          const prev = prevMap.get(url)
          try {
            const script = await fetchText(url, 5)
            if (!script.trim()) throw new Error('下载到的文件为空')
            if (!/^\/\*[\s\S]+?\*\//.test(script.replace(/^\uFEFF/, ''))) {
              throw new Error('不是有效的自定义源脚本（缺少文件头注释块）')
            }
            const hash = hashOf(script)
            const name = readScriptInfo(script, 'name') || prev?.name || url
            const version = readScriptInfo(script, 'version')

            // 内容没变且源还在 → 不动它（避免每次启动都重建，导致选中项丢失）
            const stillThere = prev && prev.apiId && (userApi.list() || []).some(item => item.id === prev.apiId)
            if (prev && prev.hash === hash && stillThere) {
              unchanged++
              next.push({ ...prev, name, version })
              lines.push(`未变化：${name}`)
              continue
            }

            // 客户端导入接口每次都生成新 id，无法原地覆盖 → 先移除旧的
            const wasActive = !!(prev && prev.apiId && userApi.getActiveId() === prev.apiId)
            if (prev && prev.apiId) {
              try {
                await userApi.remove([prev.apiId])
              } catch (err) {
                api.logger.warn(`移除旧源失败（${prev.name || url}）：`, err)
              }
            }

            const res = await userApi.importScript(script)
            if (!res.success) throw new Error(res.message || '导入失败')
            const apiId = (res.apiInfo && res.apiInfo.id) || ''
            // 原来处于选中状态 → 把选中项切到新 id，保留用户的勾选
            if (wasActive && apiId) {
              try {
                userApi.setActiveId(apiId)
              } catch (err) {
                api.logger.warn('恢复自定义源选中项失败：', err)
              }
            }
            imported++
            next.push({ url, apiId, name, version, hash, updatedAt: now })
            lines.push(`${wasActive ? '已更新（并保持选中）' : '已更新'}：${name}${version ? ` v${version}` : ''}`)
          } catch (err) {
            failed++
            if (prev) next.push(prev)
            lines.push(`失败：${url} —— ${err.message}`)
          }
        }

        // 列表里已去掉、但之前导入过的源：保留账本，不自动删除（避免误删用户仍在用的源）
        for (const item of state.sources) {
          if (!urls.includes(item.url)) next.push(item)
        }

        state.sources = next
        state.lastUpdateAt = now
        state.lastResult =
          `${reason}完成（${formatTime(now)}）：更新 ${imported} 个、未变化 ${unchanged} 个、失败 ${failed} 个\n` +
          lines.join('\n')
        api.logger.info(`远程自定义源更新完成：更新 ${imported}、未变化 ${unchanged}、失败 ${failed}`)
      } catch (err) {
        state.lastResult = `更新失败（${formatTime(Date.now())}）：${err.message}`
        api.logger.error('更新远程自定义源失败：', err)
      } finally {
        running = false
        persist()
      }
    }

    /** 移除本插件导入的全部远程源 */
    const removeAll = async() => {
      const userApi = bridge()
      if (!userApi) {
        state.lastResult = '当前客户端未提供「自定义源」接口'
        persist()
        return
      }
      const ids = state.sources.map(item => item.apiId).filter(Boolean)
      if (!ids.length) {
        state.lastResult = '本插件还没有导入过远程源'
        persist()
        return
      }
      try {
        const active = userApi.getActiveId()
        await userApi.remove(ids)
        // 被移除的源如果正是当前选中的，清掉选中项，避免指向一个已不存在的源
        if (ids.includes(active)) userApi.setActiveId('')
        state.sources = []
        state.lastResult = `已移除本插件导入的 ${ids.length} 个远程源（${formatTime(Date.now())}）`
      } catch (err) {
        state.lastResult = `移除失败：${err.message}`
      }
      persist()
    }

    ctx = { api, state, updateAll, removeAll }

    /* ---------- 声明式设置面板（宿主统一渲染，配置写入插件目录） ---------- */
    if (api.registerSettings) {
      api.registerSettings({
        title: '远程自定义源',
        fields: [
          {
            type: 'text',
            key: 'listUrl',
            label: '远程列表文件地址',
            default: '',
            placeholder: 'https://example.com/lx-sources.txt',
            tip: '纯文本列表，每行一个自定义源 js 的地址；以 # 或 // 开头的行会被忽略。',
          },
          {
            type: 'switch',
            key: 'autoUpdate',
            label: '自动更新',
            default: true,
            suffix: () => (state.lastUpdateAt ? `上次更新：${formatTime(state.lastUpdateAt)}` : '尚未更新过'),
            tip: '开启后每次启动客户端都会重新拉取列表并更新已导入的源。',
          },
          {
            type: 'buttons',
            buttons: [
              { label: '立即导入 / 更新', action: 'update' },
              { label: '移除本插件导入的全部源', action: 'removeAll' },
            ],
          },
          { type: 'divider' },
          { type: 'info', label: '状态', text: () => state.lastResult || '尚未执行' },
          {
            type: 'list',
            label: '已导入的远程源',
            items: () => state.sources.map(item => ({
              name: item.name || item.url,
              desc: `${item.url}${item.version ? ` · v${item.version}` : ''}`,
              status: item.updatedAt ? `更新于 ${formatTime(item.updatedAt)}` : '导入时间未知',
            })),
            tip: '列表文件里已去掉的地址不会被自动删除，可用上面的按钮整体移除。',
          },
          { type: 'divider' },
          {
            type: 'switch',
            key: 'dedupe',
            label: '搜索结果同源去重',
            default: true,
            tip: '只去掉同一个音乐源内部重复的条目，不跨源合并。',
          },
        ],
      })
    }

    /* ---------- 搜索结果增强：运行时包装 musicSdk.searchMusic ---------- */
    const sdk = api.app && api.app.musicSdk
    if (sdk && typeof sdk.searchMusic === 'function') {
      api.patch(sdk, 'searchMusic', async(next, options) => {
        const result = await next(options)
        if (!state.dedupe) return result
        const { sources, removed } = dedupeSearchResult(result)
        if (removed > 0) {
          stats.removedTotal += removed
          stats.lastRemoved = removed
          api.setData('stats', stats)
          api.logger.info(`搜索结果去重：去除 ${removed} 条重复项（累计 ${stats.removedTotal} 条）`)
        }
        return sources
      })
    } else {
      api.logger.warn('未找到 musicSdk.searchMusic，跳过搜索增强（远程源功能不受影响）')
    }

    /* ---------- 启动时自动更新 ---------- */
    api.hooks.on('app:ready', () => {
      api.logger.info(
        `已就绪：v${api.version}，已导入 ${state.sources.length} 个远程源；` +
        `上次更新 ${formatTime(state.lastUpdateAt)}`,
      )
      if (!state.autoUpdate) {
        api.logger.info('未开启自动更新，跳过')
        return
      }
      if (!state.listUrl) {
        api.logger.info('尚未配置远程列表文件地址，跳过自动更新')
        return
      }
      // 延迟一点再跑：让 app 自身的初始化（含自定义源列表载入）先完成，
      // 否则两边都在写同一份列表，可能相互覆盖。
      setTimeout(() => { void updateAll('启动自动更新') }, STARTUP_DELAY)
    })
  },

  /** 设置面板改动配置后由宿主调用：立刻同步进内存状态，无需重启客户端 */
  onConfigChange(next) {
    if (!ctx) return undefined
    // 面板改的键直接同步进内存状态（配置实体由宿主写入插件目录的 config.json）
    for (const key of Object.keys(DEFAULT_CONFIG)) {
      if (key in next) ctx.state[key] = next[key]
    }
    return undefined
  },

  /** 设置面板上的按钮被点击 */
  onSettingsAction(action) {
    if (!ctx) return undefined
    if (action === 'update') return ctx.updateAll('手动更新')
    if (action === 'removeAll') return ctx.removeAll()
    return undefined
  },

  /** 卸载/禁用时调用（宿主还会自动回退 patch 与 hooks） */
  uninstall() {
    ctx = null
    console.log('[plugin:repo-source-plugins] 已卸载：搜索增强已还原；已导入的自定义源仍保留在「自定义源」列表中')
  },

  /** 插件被更新后调用，oldVersion 为旧版本号 */
  onUpdate(oldVersion) {
    console.log(`[plugin:repo-source-plugins] 已从 v${oldVersion} 更新（配置与账本保留在插件目录）`)
  },
}
