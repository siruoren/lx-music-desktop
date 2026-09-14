import { app } from 'electron'
import './utils/logInit'
import '@common/error'
import {
  initGlobalData,
  initSingleInstanceHandle,
  applyElectronEnvParams,
  setUserDataPath,
  registerDeeplink,
  listenerAppEvent,
} from './app'
import { isLinux } from '@common/utils'
import { initAppSetting } from '@main/app'
import registerModules from '@main/modules'
// === Plugin Manager ===
import { initPluginManager } from '../plugins/main'

// 初始化应用
const init = () => {
  console.log('init')
  void initAppSetting().then(() => {
    // === Plugin Manager：先同步注册插件管理 IPC（避免渲染进程过早调用），
    // 并异步加载已启用的主进程插件；初始化失败不影响主程序启动 ===
    void initPluginManager().catch(err => { console.error('[plugin] 初始化失败（不影响主程序）：', err) })
    registerModules()
    global.lx.event_app.app_inited()
  })
}

initGlobalData()
initSingleInstanceHandle()
applyElectronEnvParams()
setUserDataPath()
registerDeeplink(init)
listenerAppEvent(init)


// https://github.com/electron/electron/issues/16809
void app.whenReady().then(() => {
  isLinux ? setTimeout(init, 300) : init()
})
