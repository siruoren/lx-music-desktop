import { userApis as defaultUserApis } from './config'
import { STORE_NAMES } from '@common/constants'
import getStore from '@main/utils/store'
import zlib from 'node:zlib'

let userApis: LX.UserApi.UserApiInfo[] | null
let scripts = new Map<string, string>()

const saveData = () => {
  getStore(STORE_NAMES.USER_API).set('userApis', userApis!.map(api => {
    return {
      ...api,
      script: scripts.get(api.id),
    }
  }))
}

export const getUserApis = (): LX.UserApi.UserApiInfo[] => {
  if (userApis) return userApis

  const electronStore_userApi = getStore(STORE_NAMES.USER_API)
  let infoFull = electronStore_userApi.get('userApis') as LX.UserApi.UserApiInfoFull[]
  let requiredUpdate = false
  if (infoFull) {
    for (let i = 0; i < infoFull.length; i++) {
      const api = infoFull[i]
      if (api.version != null) continue
      requiredUpdate ||= true
      try {
        infoFull.splice(i, 1, {
          ...parseScriptInfo(api.script),
          ...api,
        })
      } catch (e) {
        infoFull.splice(i, 1)
        i--
      }
    }
  } else {
    infoFull = defaultUserApis
    electronStore_userApi.set('userApis', userApis)
  }
  userApis = infoFull.map(api => {
    if (api.allowShowUpdateAlert == null) api.allowShowUpdateAlert = false
    if (api.autoUpdate == null) api.autoUpdate = false
    const { script, ...info } = api
    scripts.set(api.id, script)
    return info
  })
  if (requiredUpdate) saveData()
  return userApis
}

const INFO_NAMES = {
  name: 24,
  description: 36,
  author: 56,
  homepage: 1024,
  version: 36,
} as const
type INFO_NAMES_Type = typeof INFO_NAMES
const matchInfo = (scriptInfo: string) => {
  const infoArr = scriptInfo.split(/\r?\n/)
  const rxp = /^\s?\*\s?@(\w+)\s(.+)$/
  const infos: Partial<Record<keyof typeof INFO_NAMES, string>> = {}
  for (const info of infoArr) {
    const result = rxp.exec(info)
    if (!result) continue
    const key = result[1] as keyof typeof INFO_NAMES
    if (INFO_NAMES[key] == null) continue
    infos[key] = result[2].trim()
  }

  for (const [key, len] of Object.entries(INFO_NAMES) as Array<{ [K in keyof INFO_NAMES_Type]: [K, INFO_NAMES_Type[K]] }[keyof INFO_NAMES_Type]>) {
    infos[key] ||= ''
    if (infos[key] == null) infos[key] = ''
    else if (infos[key].length > len) infos[key] = infos[key].substring(0, len) + '...'
  }

  return infos as Record<keyof typeof INFO_NAMES, string>
}
const parseScriptInfo = (script: string) => {
  const result = /^\/\*[\S|\s]+?\*\//.exec(script)
  if (!result) throw new Error('无效的自定义源文件')

  let scriptInfo = matchInfo(result[0])

  scriptInfo.name ||= `user_api_${new Date().toLocaleString()}`
  return scriptInfo
}
const deflateScript = async(script: string) => new Promise<string>((resolve, reject) => {
  zlib.deflate(Buffer.from(script, 'utf8'), (err, buf) => {
    if (err) {
      reject(err)
      return
    }
    resolve('gz_' + buf.toString('base64'))
  })
})
const inflateScript = async(script: string) => new Promise<string>((resolve, reject) => {
  if (script.startsWith('gz_')) {
    zlib.inflate(Buffer.from(script.substring(3), 'base64'), (err, buf) => {
      if (err) {
        reject(err)
        return
      }
      resolve(buf.toString('utf8'))
    })
  } else resolve(script)
})
export const importApi = async(scriptRaw: string, url?: string): Promise<LX.UserApi.UserApiInfo> => {
  let scriptInfo = parseScriptInfo(scriptRaw)
  const script = await deflateScript(scriptRaw)
  userApis ??= []
  for (const api of userApis) {
    const existingScript = scripts.get(api.id)
    if (existingScript === script) {
      throw new Error(`导入失败，脚本内容与已有的源「${api.name}」相同`)
    }
  }
  const apiInfo = {
    id: `user_api_${Math.random().toString().substring(2, 5)}_${Date.now()}`,
    ...scriptInfo,
    allowShowUpdateAlert: true,
    // 在线导入的源默认开启自动更新，本地导入的源没有回源地址，无法自动更新
    autoUpdate: !!url,
    url,
  }
  userApis.push(apiInfo)
  scripts.set(apiInfo.id, script)
  saveData()
  return apiInfo
}

/**
 * 用新的脚本内容更新已存在的源
 * 更新时保持 id 及用户的勾选状态（allowShowUpdateAlert、autoUpdate、url）不变，
 * 这样即使新脚本里源名称、描述等信息发生了变更，原有的勾选状态也不会丢失
 */
export const updateApi = async(id: string, scriptRaw: string): Promise<LX.UserApi.UserApiInfo> => {
  const targetApi = userApis?.find(api => api.id == id)
  if (!targetApi) throw new Error('更新失败，源不存在')

  const scriptInfo = parseScriptInfo(scriptRaw)
  const script = await deflateScript(scriptRaw)

  Object.assign(targetApi, {
    ...scriptInfo,
    id: targetApi.id,
    allowShowUpdateAlert: targetApi.allowShowUpdateAlert,
    autoUpdate: targetApi.autoUpdate,
    url: targetApi.url,
  })
  // sources 由脚本运行时上报，脚本已变更，需等重新初始化后再写入
  delete targetApi.sources

  scripts.set(targetApi.id, script)
  saveData()

  return { ...targetApi }
}

export const removeApi = (ids: string[]) => {
  if (!userApis) return
  for (let index = userApis.length - 1; index > -1; index--) {
    if (ids.includes(userApis[index].id)) {
      scripts.delete(userApis[index].id)
      userApis.splice(index, 1)
      ids.splice(index, 1)
    }
  }
  saveData()
}

export const setAllowShowUpdateAlert = (id: string, enable: boolean) => {
  const targetApi = userApis?.find(api => api.id == id)
  if (!targetApi) return
  targetApi.allowShowUpdateAlert = enable
  saveData()
}

export const setAutoUpdate = (id: string, enable: boolean) => {
  const targetApi = userApis?.find(api => api.id == id)
  if (!targetApi) return
  targetApi.autoUpdate = enable
  saveData()
}

export const getScript = async(id: string) => {
  return inflateScript(scripts.get(id) ?? '')
}
