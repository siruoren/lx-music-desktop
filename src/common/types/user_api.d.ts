declare namespace LX {
  namespace UserApi {
    type UserApiSourceInfoType = 'music'
    type UserApiSourceInfoActions = 'musicUrl' | 'lyric' | 'pic'

    interface UserApiSourceInfo {
      name: string
      type: UserApiSourceInfoType
      actions: UserApiSourceInfoActions[]
      qualitys: LX.Quality[]
    }

    type UserApiSources = Record<LX.Source, UserApiSourceInfo>


    interface UserApiInfoFull {
      id: string
      name: string
      description: string
      script: string
      allowShowUpdateAlert: boolean
      /** 是否随软件启动自动更新（仅在线导入的源有效） */
      autoUpdate: boolean
      /** 在线导入时的脚本地址，作为自动更新的回源地址，本地导入的源没有此字段 */
      url?: string
      author?: string
      homepage?: string
      version?: string
      sources?: UserApiSources
    }

    type UserApiInfo = Omit<UserApiInfoFull, 'script'>

    interface UserApiStatus {
      status: boolean
      message?: string
      apiInfo?: UserApiInfo
    }

    interface UserApiUpdateInfo {
      name: string
      description: string
      log: string
      updateUrl?: string
    }

    interface UserApiRequestParams {
      requestKey: string
      data: any
    }
    type UserApiRequestCancelParams = string
    type UserApiSetApiParams = string

    interface UserApiSetAllowUpdateAlertParams {
      id: string
      enable: boolean
    }

    interface UserApiSetAutoUpdateParams {
      id: string
      enable: boolean
    }

    interface UserApiImportParams {
      script: string
      url?: string
    }

    interface UserApiUpdateParams {
      id: string
      script: string
    }

    interface ImportUserApi {
      apiInfo: UserApiInfo
      apiList: UserApiInfo[]
    }

  }
}
