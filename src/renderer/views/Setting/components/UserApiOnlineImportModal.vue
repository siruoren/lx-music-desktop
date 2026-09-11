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
        <label :class="$style.dirLabel">{{ $t('user_api_import_dir_url') }}</label>
        <div :class="$style.dirRow">
          <base-input
            ref="dirInput"
            v-model="dirUrl"
            :class="$style.dirInput"
            type="url"
            :placeholder="$t('user_api_import_dir_url_tip')"
            @submit="handleSaveDir"
          />
          <base-btn :class="$style.btn" :disabled="disabled" @click="handleSaveDir">{{ $t('user_api_import_dir_save') }}</base-btn>
        </div>
      </div>

      <div :class="$style.footer">
        <base-btn :class="$style.btn" @click="handleClose">{{ $t('btn_close') }}</base-btn>
        <base-btn :class="$style.btn" :disabled="disabled" @click="handleDefaultImport">{{ defaultBtnText }}</base-btn>
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
      disabled: false,
      btnText: '',
      defaultBtnText: '',
      dirUrl: '',
    }
  },
  watch: {
    show(n) {
      if (n) {
        this.url = ''
        this.dirUrl = appSetting['userApi.importDirUrl'] || ''
        this.disabled = false
        this.btnText = this.$t('user_api_import_online__input_confirm')
        this.defaultBtnText = this.$t('user_api_import_online__btn_default')
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
      let url = this.verify()
      if (!url) return
      this.disabled = true
      this.btnText = this.$t('user_api_import_online__input_loading')
      let script
      try {
        script = await httpFetch(url, { follow_max: 3, noProxy: true }).promise.then(resp => resp.body)
      } catch (err) {
        void dialog(this.$t('user_api_import__failed', { message: err.message }))
        return
      } finally {
        this.disabled = false
        this.btnText = this.$t('user_api_import_online__input_confirm')
      }
      if (script.length > 9_000_000) {
        void dialog(this.$t('user_api_import__failed', {
          message: 'Too large script',
          confirm: this.$t('ok'),
        }))
        return
      }
      this.$emit('import', script, url)
      this.handleClose()
    },
    buildContentsApiUrl(raw) {
      const url = (raw || '').trim()
      if (!url) return ''
      // 已是 contents API 地址
      let m = url.match(/^https:\/\/api\.github\.com\/repos\/([^/]+)\/([^/]+)\/contents(\/.*)?$/)
      if (m) {
        const base = `https://api.github.com/repos/${m[1]}/${m[2]}/contents${m[3] || ''}`
        return base + (base.includes('?') ? '&' : '?') + 'per_page=100'
      }
      // github.com 的 tree/blob 页面地址，转换为 contents API
      m = url.match(/^https:\/\/github\.com\/([^/]+)\/([^/]+)(?:\/(tree|blob)\/([^/]+)(?:\/(.*))?)?$/)
      if (m) {
        const owner = m[1]
        const repo = m[2]
        const branch = m[4] || 'main'
        const path = m[5] || ''
        const contentsPath = path ? `/${path}` : ''
        return `https://api.github.com/repos/${owner}/${repo}/contents${contentsPath}?ref=${branch}&per_page=100`
      }
      return ''
    },
    handleSaveDir() {
      const raw = (this.dirUrl || '').trim()
      if (!raw) {
        void dialog(this.$t('user_api_import_dir_empty'))
        return
      }
      updateSetting({ 'userApi.importDirUrl': raw })
      // 保存后自动刷新重新导入
      this.handleDefaultImport(raw)
    },
    async handleDefaultImport(address) {
      const addr = (address || '').trim() || (this.dirUrl || '').trim() || (appSetting['userApi.importDirUrl'] || '')
      if (!addr) {
        void dialog(this.$t('user_api_import_dir_empty_hint'))
        if (this.$refs.dirInput && this.$refs.dirInput.focus) this.$refs.dirInput.focus()
        return
      }
      const listUrl = this.buildContentsApiUrl(addr)
      if (!listUrl) {
        void dialog(this.$t('user_api_import_dir_invalid'))
        return
      }

      this.disabled = true
      this.btnText = this.$t('user_api_import_online__input_confirm')
      this.defaultBtnText = this.$t('user_api_import_online__default_loading')

      let listResp
      try {
        listResp = await httpFetch(listUrl, { follow_max: 3, noProxy: true, timeout: 20_000 }).promise
      } catch (err) {
        void dialog(this.$t('user_api_import__failed', { message: err.message }))
        this.disabled = false
        this.defaultBtnText = this.$t('user_api_import_online__btn_default')
        return
      }

      const entries = listResp.body
      if (!Array.isArray(entries)) {
        void dialog(this.$t('user_api_import__failed', { message: 'Unexpected response' }))
        this.disabled = false
        this.defaultBtnText = this.$t('user_api_import_online__btn_default')
        return
      }
      const jsFiles = entries.filter(e => e && e.type === 'file' && typeof e.name === 'string' && e.name.endsWith('.js') && e.download_url)
      if (!jsFiles.length) {
        void dialog(this.$t('user_api_default_import_empty'))
        this.disabled = false
        this.defaultBtnText = this.$t('user_api_import_online__btn_default')
        return
      }

      const items = []
      for (const file of jsFiles) {
        try {
          const resp = await httpFetch(file.download_url, { follow_max: 3, noProxy: true, timeout: 20_000 }).promise
          const script = resp.body
          if (typeof script != 'string' || !script.length) continue
          if (script.length > 9_000_000) continue
          items.push({ script, url: file.download_url })
        } catch (err) {
          console.log('Download default user api script failed:', file.name, err)
        }
      }

      this.disabled = false
      this.defaultBtnText = this.$t('user_api_import_online__btn_default')
      if (!items.length) {
        void dialog(this.$t('user_api_default_import_empty'))
        return
      }
      this.$emit('import-default', items)
      this.handleClose()
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
