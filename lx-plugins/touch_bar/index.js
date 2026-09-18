'use strict'

/**
 * touch_bar —— 在 macOS Touch Bar 上显示播放状态并控制播放，并实时显示大字歌词（长歌词自动滚动）。
 *
 * 这是一个**主进程（main）**插件：Touch Bar 是 Electron 主进程专属的 GUI，
 * 必须在主进程用 api.electron.TouchBar 构造、并经 api.setTouchBar 挂到主窗口。
 *
 * 能力依赖（详见 src/plugins 宿主，框架层新增）：
 *   - api.electron       宿主注入的主进程 electron 模块；TouchBar 及其子组件 Button/Label/Spacer 取法见下方 setup
 *   - api.setTouchBar    把构造好的 TouchBar 挂到主窗口（窗口未就绪时自动挂起、就绪后应用）
 *   - api.controlPlayer  向 renderer 发播放控制指令（play/pause/prev/next/collect/unCollect）
 *   - api.app.event_app  订阅 player_status 事件，实时拿到播放状态
 *                       字段含：status / name / singer / collect / progress / duration /
 *                       lyricLineText（当前歌词行）/ lyricLineAllText（含翻译）等
 *
 * 歌词数据来自 player_status.lyricLineText（renderer 在 lyricLinePlay 时广播），无需改 app。
 *
 * 按钮图标说明：
 *   - 用 api.electron.nativeImage 现画「扁平单色」图标（template image），而非 emoji 文字。
 *     template image 只认 alpha 通道、颜色被系统统一为当前外观色 → 扁平、自动适配浅/深色，
 *     且去掉文字标签后图标占据整个按钮、视觉上更大更干净（贴近官方 Music app 观感）。
 *   - Touch Bar 按钮的图标尺寸由系统固定，无法再放大；本插件已让图标尽量填满画布以最大化显示。
 *
 * 仅 macOS 生效；其它平台 TouchBar 为 no-op，插件静默不报错，也不会影响其它功能。
 *
 * 关于「后台也显示」：macOS 的 Touch Bar 永远显示**当前最前台 App** 的 Touch Bar，
 * 本插件把自定义 Touch Bar 挂在主窗口上，只要 lx-music 是前台 App（即使窗口最小化）就会显示；
 * 当切到其它 App 时显示的是那个 App 的 Touch Bar——这是系统行为，单靠 setTouchBar 无法突破。
 * 若要做到「像官方 Music app 那样切到别的 App 也常驻」，需要接入系统级 Now Playing
 * （MPNowPlayingInfoCenter / navigator.mediaSession），属 App 层能力，需另立项。
 */

/* ------------------------------------------------------------------ *
 * 纯 Node 的极简 PNG 编码器（RGBA → PNG），用于把现画的图标导出为 nativeImage。
 * 仅依赖 Node 内置 zlib，无需任何 npm 包，也不依赖项目 node_modules。
 * ------------------------------------------------------------------ */
const CRC_TABLE = (() => {
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1)
    t[n] = c >>> 0
  }
  return t
})()
function crc32(buf) {
  let c = 0xFFFFFFFF
  for (let i = 0; i < buf.length; i++) c = (CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8)) >>> 0
  return (c ^ 0xFFFFFFFF) >>> 0
}
function pngFromRGBA(width, height, rgba) {
  const zlib = require('zlib')
  const stride = width * 4
  const raw = Buffer.alloc((stride + 1) * height)
  for (let y = 0; y < height; y++) {
    const dst = y * (stride + 1)
    raw[dst] = 0 // 过滤器：none
    rgba.copy(raw, dst + 1, y * stride, y * stride + stride)
  }
  const idat = zlib.deflateSync(raw, { level: 9 })

  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0)
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body) >>> 0, 0)
    return Buffer.concat([len, body, crc])
  }

  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 6 // color type: RGBA
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))])
}

/** 现画一组「扁平单色」图标（template image）。仅在 setup 内、拿到 electron 后调用。 */
function buildIcons(electronApi) {
  const SIZE = 48
  const make = (draw) => {
    const buf = Buffer.alloc(SIZE * SIZE * 4) // 全透明
    const cv = {
      // template image 只认 alpha；颜色无所谓，统一写白，由系统渲染为外观色
      set(x, y, a = 255) {
        x = Math.round(x); y = Math.round(y)
        if (x < 0 || y < 0 || x >= SIZE || y >= SIZE) return
        const i = (y * SIZE + x) * 4
        buf[i] = 255; buf[i + 1] = 255; buf[i + 2] = 255; buf[i + 3] = a
      },
      rect(x0, y0, w, h, a = 255) {
        for (let y = Math.floor(y0); y < y0 + h; y++)
          for (let x = Math.floor(x0); x < x0 + w; x++) cv.set(x, y, a)
      },
      tri(ax, ay, bx, by, cx, cy, a = 255) {
        const minX = Math.floor(Math.min(ax, bx, cx))
        const maxX = Math.ceil(Math.max(ax, bx, cx))
        const minY = Math.floor(Math.min(ay, by, cy))
        const maxY = Math.ceil(Math.max(ay, by, cy))
        const area = (bx - ax) * (cy - ay) - (cx - ax) * (by - ay)
        if (area === 0) return
        for (let y = minY; y <= maxY; y++) {
          for (let x = minX; x <= maxX; x++) {
            const w0 = ((bx - ax) * (y + 0.5 - ay) - (by - ay) * (x + 0.5 - ax)) / area
            const w1 = ((cx - bx) * (y + 0.5 - by) - (cy - by) * (x + 0.5 - bx)) / area
            const w2 = ((ax - cx) * (y + 0.5 - cy) - (ay - cy) * (x + 0.5 - cx)) / area
            if (w0 >= 0 && w1 >= 0 && w2 >= 0) cv.set(x, y, a)
          }
        }
      },
    }
    draw(cv)
    const png = pngFromRGBA(SIZE, SIZE, buf)
    const img = electronApi.nativeImage.createFromBuffer(png)
    img.setTemplateImage(true) // 关键：扁平单色、随系统外观
    return img
  }

  // 心形隐函数：(x²+y²-1)³ - x²y³ ≤ 0（y 向上）。scale 越大图形越大。
  const heart = (fx, fy) => Math.pow(fx * fx + fy * fy - 1, 3) - fx * fx * fy * fy * fy
  const stampHeart = (c, scale) => {
    for (let y = 0; y < SIZE; y++) {
      for (let x = 0; x < SIZE; x++) {
        const fx = (x - 24) / scale
        const fy = (24 - y) / scale
        if (heart(fx, fy) <= 0) c.set(x, y, 255)
      }
    }
  }

  const play = make((c) => c.tri(16, 10, 16, 38, 38, 24))
  const pause = make((c) => { c.rect(15, 10, 7, 28); c.rect(26, 10, 7, 28) })
  const prev = make((c) => { c.rect(10, 12, 5, 24); c.tri(34, 12, 34, 36, 17, 24) })
  const next = make((c) => { c.rect(33, 12, 5, 24); c.tri(14, 12, 14, 36, 31, 24) })

  // 实心心（已收藏）
  const likeFilled = make((c) => stampHeart(c, 15))
  // 空心心（未收藏）：实心后把“更小版”抹成透明 → 得到轮廓
  const likeOutline = make((c) => {
    stampHeart(c, 15)
    for (let y = 0; y < SIZE; y++) {
      for (let x = 0; x < SIZE; x++) {
        const fx = (x - 24) / (15 / 1.35) // 缩小版：区域更小
        const fy = (24 - y) / (15 / 1.35)
        if (heart(fx, fy) <= 0) c.set(x, y, 0)
      }
    }
  })

  return { prev, play, pause, next, like: likeFilled, unlike: likeOutline }
}

/** 卸载时清理用的反订阅 / 移除 / 停表函数（module 级，uninstall 拿不到 setup 作用域） */
let teardown = null

module.exports = {
  setup(api) {
    if (api.platform !== 'main') {
      api.logger.warn('touch_bar 仅支持主进程（main），当前端无 effect')
      return
    }
    const electronApi = api.electron
    if (!electronApi || !electronApi.TouchBar) {
      api.logger.warn('宿主未提供 api.electron，无法构造 Touch Bar')
      return
    }
    const TouchBar = electronApi.TouchBar
    // 注意：TouchBarButton/Label/Spacer 是 TouchBar 类的**静态成员**，不是 electron 的顶层导出。
    // 必须从 TouchBar 上取，否则拿到 undefined、new 时抛 "TouchBarLabel is not a constructor"。
    const { TouchBarButton, TouchBarLabel, TouchBarSpacer } = TouchBar

    const ICON = buildIcons(electronApi)

    let isPlaying = false
    let isCollected = false
    let songName = '' // "歌曲名 - 歌手"
    let hasLyric = false
    let lyricText = '' // 当前歌词行（lyricLineText）

    // ---- 控件实例：status 变化时直接改 .icon / .label 即可实时反映（无需重建 TouchBar）----
    // 大字歌词标签：fontSize 让 Touch Bar 上的文字明显放大（仅 TouchBarLabel 支持，Button 不支持字号）
    const lyricLabel = new TouchBarLabel({ label: '未播放', fontSize: 16 })
    // 控制按钮：扁平单色图标（template image，无文字标签 → 图标更大更干净）
    const prevBtn = new TouchBarButton({ icon: ICON.prev, click: () => api.controlPlayer('prev') })
    const playBtn = new TouchBarButton({
      icon: ICON.play,
      click: () => api.controlPlayer(isPlaying ? 'pause' : 'play'),
    })
    const nextBtn = new TouchBarButton({ icon: ICON.next, click: () => api.controlPlayer('next') })
    const likeBtn = new TouchBarButton({
      icon: ICON.unlike,
      click: () => api.controlPlayer(isCollected ? 'unCollect' : 'collect'),
    })

    // 布局：左侧四个控制图标；右侧区域用两个等权 flexible 间隔把歌词夹在中间 → 歌词在按钮右侧区域居中显示。
    const flexL = new TouchBarSpacer({ size: 'flexible' })
    const flexR = new TouchBarSpacer({ size: 'flexible' })
    const touchBar = new TouchBar({
      items: [
        prevBtn,
        playBtn,
        nextBtn,
        likeBtn,
        flexL,
        lyricLabel,
        flexR,
      ],
    })
    api.setTouchBar(touchBar)

    // ---- 歌词大字滚动（marquee）----
    // 单行字符预算：超过即滚动；CJK 字符宽，取保守值。fontSize 16 下 Touch Bar 宽度足够显示约 18 字。
    const MAX = 18
    const SEP = '　　' // 循环滚动时的分隔空白（全角空格）
    let scrollTimer = null
    let scrollOffset = 0

    const fits = (t) => t.length <= MAX

    // 静态显示（不滚动）：清掉滚动定时器，直接显示整段
    const renderStatic = (t) => {
      if (scrollTimer) {
        clearInterval(scrollTimer)
        scrollTimer = null
      }
      scrollOffset = 0
      lyricLabel.label = t
      api.setTouchBar(touchBar)
    }

    // 滚动显示：每 250ms 平移一个字符窗口（循环），期间只改 .label 不重挂 Touch Bar，避免闪烁
    const startScroll = (t) => {
      if (fits(t)) {
        renderStatic(t)
        return
      }
      if (scrollTimer) clearInterval(scrollTimer)
      scrollOffset = 0
      const buf = t + SEP
      const total = buf.length
      const paint = () => {
        const tail = buf.substring(scrollOffset)
        const head = buf.substring(0, scrollOffset)
        lyricLabel.label = (tail + head).substring(0, MAX)
      }
      paint()
      scrollTimer = setInterval(() => {
        scrollOffset = (scrollOffset + 1) % total
        paint()
      }, 250)
    }

    // 大标签内容优先级：当前歌词行 > 歌曲名 > 未播放
    const updateBigLabel = () => {
      const target = hasLyric && lyricText ? lyricText : (songName || '未播放')
      if (fits(target)) renderStatic(target)
      else startScroll(target)
    }

    // 监听播放状态：renderer 每次播放/切歌/暂停/换歌词行都会经 player_status 广播到这里。
    // 注意：进度（progress/duration）与 seek 类事件只带数值、不带 name/lyricLineText，绝不能因此清空歌词或标题。
    const onStatus = (status) => {
      if (!status || typeof status !== 'object') return
      let changed = false

      if (typeof status.status === 'string') {
        const playing = status.status === 'playing'
        if (playing !== isPlaying) {
          isPlaying = playing
          playBtn.icon = isPlaying ? ICON.pause : ICON.play
          changed = true
        }
        if (status.status === 'stoped') {
          // 显式停止：清空歌曲名与歌词（不带 name 的 progress 事件不在此列）
          hasLyric = false
          lyricText = ''
          songName = ''
          changed = true
        }
      }
      if (typeof status.collect === 'boolean' && status.collect !== isCollected) {
        isCollected = status.collect
        likeBtn.icon = isCollected ? ICON.like : ICON.unlike
        changed = true
      }
      // 仅在带曲目信息时才更新歌曲名；进度/seek 类事件不带 name，保持原样
      if (typeof status.name === 'string') {
        songName = status.name ? `${status.name} - ${status.singer || ''}` : ''
        if (status.name) hasLyric = false // 新歌：先显示歌名，待歌词行到达后再切到歌词
        changed = true
      }
      // 当前歌词行：renderer 在 lyricLinePlay 时广播；空串表示暂无（如间奏），回退到歌名
      if (typeof status.lyricLineText === 'string') {
        if (status.lyricLineText) {
          hasLyric = true
          lyricText = status.lyricLineText
        } else {
          hasLyric = false
          lyricText = ''
        }
        changed = true
      }
      // 离散变化（切歌/换词/播放态/收藏）：更新大标签并重新挂一次 Touch Bar
      // 滚动过程中的高频 tick 不在此路径，只改 .label，不会触发重挂
      if (changed) {
        updateBigLabel()
        api.setTouchBar(touchBar)
      }
    }
    api.app.event_app.on('player_status', onStatus)

    teardown = () => {
      if (scrollTimer) {
        clearInterval(scrollTimer)
        scrollTimer = null
      }
      try { api.app.event_app.off('player_status', onStatus) } catch { /* noop */ }
      try { api.setTouchBar(null) } catch { /* noop */ }
    }

    api.hooks.on('app:ready', () => {
      api.logger.info('Touch Bar 已就绪：上一首 / 播放暂停 / 下一首 / 收藏，歌词大字实时滚动')
    })
  },

  /** 卸载/禁用：停滚动定时器、反订阅播放状态事件并移除 Touch Bar */
  uninstall() {
    if (teardown) {
      teardown()
      teardown = null
    }
  },
}
