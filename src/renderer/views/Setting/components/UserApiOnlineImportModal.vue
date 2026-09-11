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
        this.dirUrl = appSetting['userApi.importListUrl'] || ''
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
    handleSaveDir() {
      const raw = (this.dirUrl || '').trim()
      if (!raw) {
        void dialog(this.$t('user_api_import_list_empty'))
        return
      }
      updateSetting({ 'userApi.importListUrl': raw })
      // 保存后自动刷新重新导入
      this.handleDefaultImport(raw)
    },
    async handleDefaultImport(address) {
      const addr = (address || '').trim() || (this.dirUrl || '').trim() || (appSetting['userApi.importListUrl'] || '')
      if (!addr) {
        void dialog(this.$t('user_api_import_list_empty_hint'))
        if (this.$refs.dirInput && this.$refs.dirInput.focus) this.$refs.dirInput.focus()
        return
      }
      if (!/^https?:\/\//.test(addr)) {
        void dialog(this.$t('user_api_import_list_invalid'))
        return
      }

      this.disabled = true
      this.btnText = this.$t('user_api_import_online__input_confirm')
      this.defaultBtnText = this.$t('user_api_import_online__default_loading')

      // 下载列表文件（内容为每行一个 .js 地址）
      let listText
      try {
        const resp = await httpFetch(addr, { follow_max: 3, noProxy: true, timeout: 20_000 }).promise
        listText = typeof resp.body === 'string' ? resp.body : JSON.stringify(resp.body)
      } catch (err) {
        void dialog(this.$t('user_api_import__failed', { message: err.message }))
        this.disabled = false
        this.defaultBtnText = this.$t('user_api_import_online__btn_default')
        return
      }

      const urls = listText.split(/\r?\n/).map(l => l.trim()).filter(l => /^https?:\/\/.+\.js(\?.*)?$/i.test(l))
      if (!urls.length) {
        void dialog(this.$t('user_api_default_import_empty'))
        this.disabled = false
        this.defaultBtnText = this.$t('user_api_import_online__btn_default')
        return
      }

      const items = []
      for (const url of urls) {
        try {
          const resp = await httpFetch(url, { follow_max: 3, noProxy: true, timeout: 20_000 }).promise
          const script = resp.body
          if (typeof script != 'string' || !script.length) continue
          if (script.length > 9_000_000) continue
          items.push({ script, url })
        } catch (err) {
          console.log('Download default user api script failed:', url, err)
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
