/**
 * 主窗口桥接（Touch Bar / 播放控制）。
 *
 * 为什么需要：插件系统运行于主进程的插件代码，拿不到 winMain/main.ts 私有的
 * `browserWindow`，也无法直接向 renderer 发播放控制指令。为了让插件（如 Touch Bar
 * 插件）能在主窗口上设置 Touch Bar、并遥控播放，这里做一个**注册式桥**：
 *   - winMain/main.ts 在窗口就绪后调用 registerMainWindowBridge 注册真实能力；
 *   - 插件宿主把 api.setTouchBar / api.controlPlayer 转发到这里。
 * 用「注册回调」而非直接 import winMain，是为了避免循环依赖
 * （winMain/main.ts 已经 import 了 plugins/main）。
 */
import type { BrowserWindow } from 'electron'

interface WindowBridge {
  /** 返回当前主窗口（窗口可能被重建，故用 getter 始终取最新实例） */
  getWindow: () => BrowserWindow | null
  /** 向 renderer 发送播放控制指令（复用 taskbar 按钮通道，action 同 taskbar：play/pause/prev/next/collect/...） */
  controlPlayer: (action: LX.Player.StatusButtonActions, data?: unknown) => void
}

let bridge: WindowBridge | null = null
/** 当前待应用的 Touch Bar；窗口尚不存在时挂起，待窗口就绪自动应用 */
let pendingTouchBar: Electron.TouchBar | null = null

/** winMain 在窗口创建后调用，注入真实的主窗口与播放控制能力 */
export function registerMainWindowBridge(b: WindowBridge): void {
  bridge = b
  applyPending()
}

export function getMainWindow(): BrowserWindow | null {
  return bridge?.getWindow() ?? null
}

function applyPending(): void {
  if (pendingTouchBar == null) return
  const win = bridge?.getWindow()
  if (!win) return
  try {
    win.setTouchBar(pendingTouchBar)
  } catch (err) {
    console.error('[plugin] 设置 Touch Bar 失败：', err)
  }
}

/** 窗口被重建（关闭后再打开）后，由 winMain 调用以重新挂上 Touch Bar */
export function reapplyTouchBar(): void {
  applyPending()
}

/**
 * 设置主窗口的 Touch Bar；传 null 表示移除。
 * 窗口尚未创建时挂起、待窗口就绪自动应用，并在窗口重建后重新应用（见 reapplyTouchBar）。
 */
export function setTouchBar(touchBar: Electron.TouchBar | null): void {
  pendingTouchBar = touchBar ?? null
  if (touchBar == null) {
    const win = bridge?.getWindow()
    if (win) {
      try { win.setTouchBar(null) } catch { /* noop */ }
    }
    return
  }
  applyPending()
}

/** 向 renderer 发送播放控制指令（action 同 taskbar 按钮：play/pause/prev/next/collect/unCollect/...） */
export function controlPlayer(action: string, data?: unknown): void {
  bridge?.controlPlayer(action, data)
}
