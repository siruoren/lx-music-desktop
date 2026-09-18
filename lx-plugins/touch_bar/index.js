'use strict'

/**
 * touch_bar —— 在 macOS Touch Bar 上显示播放状态并控制播放。
 *
 * 这是一个**主进程（main）**插件：Touch Bar 是 Electron 主进程专属的 GUI，
 * 必须在主进程用 api.electron.TouchBar 构造、并经 api.setTouchBar 挂到主窗口。
 *
 * 能力依赖（详见 src/plugins 宿主，框架层新增）：
 *   - api.electron       取 TouchBar / TouchBarButton / TouchBarLabel / TouchBarSpacer（宿主注入的主进程 electron 模块）
 *   - api.setTouchBar    把构造好的 TouchBar 挂到主窗口（窗口未就绪时自动挂起、就绪后应用）
 *   - api.controlPlayer  向 renderer 发播放控制指令（play/pause/prev/next/collect/unCollect）
 *   - api.app.event_app  订阅 player_status 事件，实时拿到播放状态（status / name / singer / collect）
 *
 * 仅 macOS 生效；其它平台 TouchBar 为 no-op，插件静默不报错，也不会影响其它功能。
 */

/** 更稳的图标字符（通用 Unicode，系统字体都有） */
const ICON = {
  prev: '⏮',
  play: '▶',
  pause: '⏸',
  next: '⏭',
  like: '♥',
  unlike: '♡',
}

/** 卸载时清理用的反订阅 / 移除函数（module 级，uninstall 拿不到 setup 作用域） */
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
    const TouchBarButton = electronApi.TouchBarButton
    const TouchBarLabel = electronApi.TouchBarLabel
    const TouchBarSpacer = electronApi.TouchBarSpacer

    let isPlaying = false
    let isCollected = false
    let songText = '未播放'

    // 各控件实例：status 变化时直接改其 .label 即可实时反映（无需重建 TouchBar）
    const songLabel = new TouchBarLabel({ label: songText })
    const prevBtn = new TouchBarButton({ label: ICON.prev, click: () => api.controlPlayer('prev') })
    const playBtn = new TouchBarButton({
      label: ICON.play,
      click: () => api.controlPlayer(isPlaying ? 'pause' : 'play'),
    })
    const nextBtn = new TouchBarButton({ label: ICON.next, click: () => api.controlPlayer('next') })
    const likeBtn = new TouchBarButton({
      label: ICON.unlike,
      click: () => api.controlPlayer(isCollected ? 'unCollect' : 'collect'),
    })

    const touchBar = new TouchBar({
      items: [
        prevBtn,
        playBtn,
        nextBtn,
        likeBtn,
        new TouchBarSpacer({ size: 'flexible' }),
        songLabel,
      ],
    })
    api.setTouchBar(touchBar)

    // 监听播放状态：renderer 每次播放/切歌/暂停都会经 player_status 事件广播到这里。
    // 注意：进度（progress/duration）与 seek 类事件只带数值、不带 name，绝不能因此清空标题。
    const onStatus = (status) => {
      if (!status || typeof status !== 'object') return
      let changed = false

      if (typeof status.status === 'string') {
        const playing = status.status === 'playing'
        if (playing !== isPlaying) {
          isPlaying = playing
          playBtn.label = isPlaying ? ICON.pause : ICON.play
          changed = true
        }
      }
      if (typeof status.collect === 'boolean' && status.collect !== isCollected) {
        isCollected = status.collect
        likeBtn.label = isCollected ? ICON.like : ICON.unlike
        changed = true
      }
      // 仅在带曲目信息时才更新标题；进度/seek 类事件不带 name，保持原样
      if (typeof status.name === 'string') {
        const text = status.name ? `${status.name} - ${status.singer || ''}` : '未播放'
        if (text !== songText) {
          songText = text
          songLabel.label = text
          changed = true
        }
      } else if (status.status === 'stoped' && songText !== '未播放') {
        // 显式停止播放：清空标题（不带 name 的 progress 事件不在此列）
        songText = '未播放'
        songLabel.label = songText
        changed = true
      }
      // label 是 TouchBarItem 的实时属性，改了即生效；为稳妥再挂一次 TouchBar
      if (changed) api.setTouchBar(touchBar)
    }
    api.app.event_app.on('player_status', onStatus)

    teardown = () => {
      try { api.app.event_app.off('player_status', onStatus) } catch { /* noop */ }
      try { api.setTouchBar(null) } catch { /* noop */ }
    }

    api.hooks.on('app:ready', () => {
      api.logger.info('Touch Bar 已就绪：上一首 / 播放暂停 / 下一首 / 收藏，状态随播放实时更新')
    })
  },

  /** 卸载/禁用：反订阅播放状态事件并移除 Touch Bar */
  uninstall() {
    if (teardown) {
      teardown()
      teardown = null
    }
  },
}
