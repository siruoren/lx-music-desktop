<template>
  <material-modal :show="show" teleport="#view" @close="handleClose" @after-enter="$refs.input.focus()">
    <main :class="$style.main">
      <h2>{{ $t('user_api_import_online__title') }}</h2>
      <base-input
        ref="input"
        v-model="url"
        :class="$style.input"
        type="url"
        :placeholder="$t('user_api_import_online__input_tip')"
        @submit="handleSubmit" @blur="verify"
      />

      <div :class="$style.dirBox">
        <label :class="$style.dirLabel">{{ $t('user_api_import_list_url') }}</label>
        <div :class="$style.dirRow">
          <base-input
            ref="dirInput"
            v-model="dirUrl"
            :class="$style.dirInput"
            type="url"
            :placeholder="$t('user_api_import_list_url_tip')"
            @submit="handleSaveDir"
          />
          <base-btn :class="$style.btn" :disabled="disabled" @click="handleSaveDir">{{ $t('user_api_import_list_save') }}</base-btn>
        </div>
      </div>

      <div :class="$style.footer">
        <base-btn :class="$style.btn" @click="handleClose">{{ $t('btn_close') }}</base-btn>
        <base-btn :class="$style.btn" :disabled="disabled" @click="handleSubmit">{{ btnText }}</base-btn>
      </div>
    </main>
  </material-modal>
</template>

<script>
import { dialog } from '@renderer/plugins/Dialog'
import { httpFetch } from '@renderer/utils/request'
import { appSetting, updateSetting } from '@renderer/store/setting'

export default {
  props: {
    show: {
      type: Boolean,
      default: false,
    },
  },
  emits: ['update:show', 'import', 'import-default'],
  data() {
    return {
      url: '',
      dirUrl: '',
      disabled: false,
      btnText: '',
    }
  },
  watch: {
    show(n) {
      if (n) {
        this.url = ''
        this.dirUrl = appSetting['userApi.importListUrl'] || ''
        this.disabled = false
        this.btnText = this.$t('user_api_import_online__input_confirm')
      }
    },
  },
  methods: {
    handleClose() {
      this.$emit('update:show', false)
    },
    verify() {
      if (!/^https?:\/\//.test(this.url)) this.url = ''
      return this.url
    },
    async handleSubmit() {
      const singleUrl = this.verify()
      const listUrl = (this.dirUrl || '').trim() || (appSetting['userApi.importListUrl'] || '').trim()
      if (!singleUrl && !listUrl) return

      this.disabled = true
      this.btnText = this.$t('user_api_import_online__input_loading')

      let importedCount = 0
      try {
        // 1) 列表文件非空时优先导入列表
        if (listUrl) {
          importedCount += await this.importList(listUrl)
        }
        // 2) 再导入单个链接
        if (singleUrl) {
          if (await this.importSingle(singleUrl)) importedCount += 1
        }
      } finally {
        this.disabled = false
        this.btnText = this.$t('user_api_import_online__input_confirm')
      }

      if (importedCount > 0) this.handleClose()
    },
    async importSingle(url) {
      let resp
      try {
        resp = await httpFetch(url, { follow_max: 3, noProxy: true }).promise
      } catch (err) {
        void dialog(this.$t('user_api_import__failed', { message: err.message }))
        return false
      }
      if (resp.statusCode !== 200) {
        void dialog(this.$t('user_api_import__failed', { message: `HTTP ${resp.statusCode}` }))
        return false
      }
      const script = resp.body
      if (typeof script !== 'string' || !script.length) {
        void dialog(this.$t('user_api_import__failed', { message: 'Empty script' }))
        return false
      }
      if (script.length > 9_000_000) {
        void dialog(this.$t('user_api_import__failed', { message: 'Too large script' }))
        return false
      }
      this.$emit('import', script, url)
      return true
    },
    async importList(addr) {
      let resp
      try {
        resp = await httpFetch(addr, { follow_max: 3, noProxy: true, timeout: 20_000 }).promise
      } catch (err) {
        void dialog(this.$t('user_api_import__failed', { message: err.message }))
        return 0
      }
      if (resp.statusCode !== 200) {
        void dialog(this.$t('user_api_import__failed', { message: `HTTP ${resp.statusCode}` }))
        return 0
      }

      const listText = typeof resp.body === 'string' ? resp.body : JSON.stringify(resp.body)
      const urls = listText.split(/\r?\n/).map(l => l.trim()).filter(l => /^https?:\/\/.+\.js(\?.*)?$/i.test(l))
      if (!urls.length) {
        void dialog(this.$t('user_api_default_import_empty'))
        return 0
      }

      // 列表文件所在目录：当其中 URL 指向父级（少了该目录段）导致 404 时，补上目录段重试
      const listDir = addr.replace(/\/[^/]*$/, '/')
      const items = []
      const failed = []
      for (const url of urls) {
        const r = await this.fetchScript(url)
        let script = r.script
        let usedUrl = url
        if (!script && r.code === 404) {
          const name = url.split('/').pop()
          const fallback = listDir + name
          if (fallback !== url) {
            const r2 = await this.fetchScript(fallback)
            if (r2.script) {
              script = r2.script
              usedUrl = fallback
            }
          }
        }
        if (script && script.length && script.length <= 9_000_000) {
          items.push({ script, url: usedUrl })
        } else {
          failed.push(url)
        }
      }

      if (!items.length) {
        void dialog(this.$t('user_api_default_import_empty'))
        return 0
      }
      this.$emit('import-default', items)
      if (failed.length) {
        void dialog(this.$t('user_api_default_import_failed', { success: items.length, failed: failed.length }))
      }
      return items.length
    },
    async fetchScript(url) {
      try {
        const resp = await httpFetch(url, { follow_max: 3, noProxy: true, timeout: 20_000 }).promise
        const code = resp.statusCode || 0
        const s = typeof resp.body === 'string' ? resp.body : null
        if (code === 200 && s && s.length) return { code, script: s }
        return { code, script: null }
      } catch (err) {
        console.log('Download default user api script failed:', url, err)
        return { code: 0, script: null }
      }
    },
    handleSaveDir() {
      const raw = (this.dirUrl || '').trim()
      if (!raw) {
        void dialog(this.$t('user_api_import_list_empty'))
        return
      }
      if (!/^https?:\/\//.test(raw)) {
        void dialog(this.$t('user_api_import_list_invalid'))
        return
      }
      updateSetting({ 'userApi.importListUrl': raw })
      void dialog(this.$t('user_api_import_list_saved'))
    },
  },
}
</script>


<style lang="less" module>
@import '@renderer/assets/styles/layout.less';

.main {
  padding: 0 15px;
  width: 450px;
  min-width: 280px;
  display: flex;
  flex-flow: column nowrap;
  min-height: 0;
  // max-height: 100%;
  // overflow: hidden;
  h2 {
    font-size: 13px;
    color: var(--color-font);
    line-height: 1.3;
    word-break: break-all;
    // text-align: center;
    padding: 15px 0 8px;
  }
}

.input {
  // width: 100%;
  // height: 26px;
  padding: 8px 8px;
}

.dirBox {
  margin-top: 14px;
  display: flex;
  flex-flow: column nowrap;
  gap: 6px;
}
.dirLabel {
  font-size: 13px;
  color: var(--color-font-label);
}
.dirRow {
  display: flex;
  flex-flow: row nowrap;
  align-items: center;
  gap: 8px;
}
.dirInput {
  flex: auto;
  min-width: 0;
  padding: 8px 8px;
}
.footer {
  margin: 20px 0 15px auto;
}
.btn {
  // box-sizing: border-box;
  // margin-left: 15px;
  // margin-bottom: 15px;
  // height: 36px;
  // line-height: 36px;
  // padding: 0 10px !important;
  min-width: 70px;
  // .mixin-ellipsis-1();

  +.btn {
    margin-left: 10px;
  }
}


</style>
