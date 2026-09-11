<template lang="pug">
dt#update {{ $t('setting__update') }}
dd
  .gap-top
    .p.small(@click="handleOpenDevTools") {{ $t('setting__update_current_label') }}{{ versionInfo.version }}
    .p.small(v-if="commit_id")
      | {{ $t('setting__update_commit_id') }}
      span.select {{ commit_id }}
    .p.small(v-if="commit_date") {{ $t('setting__update_commit_date') }}{{ commit_date }}
</template>

<script>
import { versionInfo } from '@renderer/store'
import { dateFormat } from '@common/utils/common'
import { openDevTools } from '@renderer/utils/ipc'
import { useI18n } from '@renderer/plugins/i18n'

export default {
  name: 'SettingUpdate',
  setup() {
    let lastClickTime = 0
    let clickNum = 0
    const commit_id = COMMIT_ID
    const commit_date = dateFormat(COMMIT_DATE)

    const t = useI18n()

    const handleOpenDevTools = () => {
      if (window.performance.now() - lastClickTime > 1000) {
        if (clickNum > 0) clickNum = 0
      } else {
        if (clickNum > 4) {
          openDevTools()
          clickNum = 0
          return
        }
      }
      clickNum++
      lastClickTime = window.performance.now()
    }

    return {
      versionInfo,
      handleOpenDevTools,
      commit_id,
      commit_date,
    }
  },
}
</script>

<style lang="less" module>
// .savePath {
//   font-size: 12px;
// }
</style>
