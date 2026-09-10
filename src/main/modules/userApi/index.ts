import { closeWindow } from './main'
import { getUserApis, importApi as handleImportApi, removeApi as handleRemoveApi, setAllowShowUpdateAlert as saveAllowShowUpdateAlert, updateApi as handleUpdateApi, setAutoUpdate as saveAutoUpdate } from './utils'
import { loadApi, setAllowShowUpdateAlert as setRendererEventAllowShowUpdateAlert, setAutoUpdate as setRendererEventAutoUpdate, init } from './rendererEvent/rendererEvent'

let userApiId: string | null

export const getApiList = getUserApis

export const importApi = async(script: string, url?: string): Promise<LX.UserApi.ImportUserApi> => {
  return {
    apiInfo: await handleImportApi(script, url),
    apiList: getUserApis(),
  }
}
export const updateApi = async(id: string, script: string): Promise<LX.UserApi.ImportUserApi> => {
  const { apiInfo, changed } = await handleUpdateApi(id, script)
  // 若更新的是当前正在使用的源，且脚本确实有变化，则重新加载，让新脚本生效
  if (changed && userApiId == id) await setApi(id)
  return {
    apiInfo,
    apiList: getUserApis(),
  }
}
export const removeApi = async(ids: string[]): Promise<LX.UserApi.UserApiInfo[]> => {
  if (userApiId && ids.includes(userApiId)) {
    userApiId = null
    await closeWindow()
  }
  handleRemoveApi(ids)
  return getUserApis()
}

export const setApi = async(id: string) => {
  if (userApiId) {
    userApiId = null
    await closeWindow()
  }
  const apiList = getUserApis()
  if (!apiList.some(a => a.id === id)) return
  userApiId ||= id
  await loadApi(id)
}

export const setAllowShowUpdateAlert = (id: string, enable: boolean) => {
  saveAllowShowUpdateAlert(id, enable)
  setRendererEventAllowShowUpdateAlert(id, enable)
}

export const setAutoUpdate = (id: string, enable: boolean) => {
  saveAutoUpdate(id, enable)
  setRendererEventAutoUpdate(id, enable)
}


export * from './rendererEvent/rendererEvent'

export default () => {
  init()

  global.lx.event_app.on('main_window_close', () => {
    void closeWindow()
  })
}
