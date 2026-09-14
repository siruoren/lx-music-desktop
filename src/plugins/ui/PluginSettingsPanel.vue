<template>
  <div :class="$style.panel">
    <div :class="$style.head">
      <span :class="$style.headTitle">{{ spec && spec.title ? spec.title : '插件设置' }}</span>
      <span :class="$style.headPath">配置保存在插件目录的 config.json</span>
      <button :class="$style.refreshBtn" @click="reload">刷新</button>
    </div>

    <div v-if="!spec" :class="$style.empty">该插件没有提供设置项。</div>

    <template v-else>
      <div v-for="(field, index) in spec.fields" :key="index" :class="$style.row">
        <hr v-if="field.type === 'divider'" :class="$style.divider" />

        <div v-else-if="field.type === 'info'" :class="$style.infoRow">
          <span :class="$style.infoText">{{ textOf(field) }}</span>
          <span v-if="suffixOf(field)" :class="$style.suffix">{{ suffixOf(field) }}</span>
        </div>

        <div v-else-if="field.type === 'list'" :class="$style.listWrap">
          <div v-if="field.label" :class="$style.label">{{ field.label }}</div>
          <ul :class="$style.list">
            <li v-for="(item, i) in itemsOf(field)" :key="i" :class="$style.listItem">
              <span :class="$style.listName">{{ item.name }}</span>
              <span v-if="item.desc" :class="$style.listDesc">{{ item.desc }}</span>
              <span v-if="item.status" :class="$style.listStatus">{{ item.status }}</span>
            </li>
            <li v-if="!itemsOf(field).length" :class="$style.listEmpty">（空）</li>
          </ul>
          <span v-if="field.tip" :class="$style.tip">{{ field.tip }}</span>
        </div>

        <div v-else-if="field.type === 'button'" :class="$style.btnRow">
          <button :class="$style.btn" :disabled="busy || field.disabled" @click="runAction(field)">
            {{ busy ? '处理中…' : field.label }}
          </button>
          <span v-if="suffixOf(field)" :class="$style.suffix">{{ suffixOf(field) }}</span>
          <span v-if="field.tip" :class="$style.tip">{{ field.tip }}</span>
        </div>

        <label v-else-if="field.type === 'switch'" :class="$style.switchRow">
          <input
            type="checkbox" :checked="!!valueOf(field)" :disabled="busy || field.disabled"
            @change="setValue(field, $event.target.checked)"
          />
          <span :class="$style.label">{{ field.label }}</span>
          <span v-if="suffixOf(field)" :class="$style.suffix">{{ suffixOf(field) }}</span>
          <span v-if="field.tip" :class="$style.tip">{{ field.tip }}</span>
        </label>

        <div v-else-if="field.type === 'textarea'" :class="$style.field">
          <span :class="$style.label">{{ field.label }}</span>
          <textarea
            :class="$style.textarea" :value="valueOf(field)" :placeholder="field.placeholder || ''"
            :disabled="busy || field.disabled" @change="setValue(field, $event.target.value)"
          ></textarea>
          <span v-if="suffixOf(field)" :class="$style.suffix">{{ suffixOf(field) }}</span>
          <span v-if="field.tip" :class="$style.tip">{{ field.tip }}</span>
        </div>

        <div v-else :class="$style.field">
          <span :class="$style.label">{{ field.label }}</span>
          <input
            :class="$style.input" :type="inputType(field)" :value="valueOf(field)"
            :placeholder="field.placeholder || ''" :disabled="busy || field.disabled"
            @change="setValue(field, $event.target.value)"
          />
          <span v-if="suffixOf(field)" :class="$style.suffix">{{ suffixOf(field) }}</span>
          <span v-if="field.tip" :class="$style.tip">{{ field.tip }}</span>
        </div>
      </div>
    </template>
  </div>
</template>

<script>
import { ref, onMounted, onBeforeUnmount } from '@common/utils/vueTools'

/**
 * 插件设置面板（宿主通用组件）。
 *
 * 插件用 api.registerSettings 声明式描述字段，这里统一渲染，因此：
 *  - 插件不必自带 Vue 组件（构建产物仍是单个 .lxplugin 文件，也不会进入 webpack 编译链）；
 *  - 配置统一保存在插件目录的 config.json，与 app 自身设置完全隔离。
 *
 * 字段上的 text / items / suffix 允许是函数，每次渲染求值，
 * 所以像「上次更新时间」「已导入的源列表」这类实时状态能自动反映出来。
 */
export default {
  name: 'PluginSettingsPanel',
  props: {
    pluginId: {
      type: String,
      required: true,
    },
  },
  setup(props) {
    const spec = ref(null)
    const values = ref({})
    const busy = ref(false)
    // 自增计数：函数型字段需要重新求值时用它触发重渲染
    const tick = ref(0)
    let timer = null
    let offConfig = null

    const getSettingsApi = () => {
      const host = window.lx && window.lx.plugins
      return (host && host.settings) || null
    }

    const reload = () => {
      const api = getSettingsApi()
      if (!api) return
      try {
        spec.value = api.get(props.pluginId) || null
        values.value = api.getConfig(props.pluginId) || {}
      } catch (err) {
        console.error('[plugin] 读取插件设置失败：', err)
      }
      tick.value++
    }

    const resolveText = v => {
      if (typeof v === 'function') {
        try { return String(v()) } catch { return '' }
      }
      return v == null ? '' : String(v)
    }

    const textOf = field => {
      void tick.value
      return resolveText(field.text)
    }
    const suffixOf = field => {
      void tick.value
      return field.suffix == null ? '' : resolveText(field.suffix)
    }
    const itemsOf = field => {
      void tick.value
      if (typeof field.items !== 'function') return []
      try { return field.items() || [] } catch { return [] }
    }
    const valueOf = field => {
      void tick.value
      return field.key ? values.value[field.key] : ''
    }

    const inputType = field => {
      if (field.type === 'password') return 'password'
      if (field.type === 'number') return 'number'
      return 'text'
    }

    const setValue = (field, value) => {
      const api = getSettingsApi()
      if (!api || !field.key) return
      const patch = {}
      patch[field.key] = value
      try {
        const next = api.setConfig(props.pluginId, patch)
        values.value = next || api.getConfig(props.pluginId) || {}
      } catch (err) {
        console.error('[plugin] 保存插件设置失败：', err)
      }
      tick.value++
    }

    const runAction = async field => {
      const api = getSettingsApi()
      if (!api || !field.action) return
      busy.value = true
      try {
        await api.runAction(props.pluginId, field.action)
      } catch (err) {
        console.error('[plugin] 执行插件设置动作失败：', err)
      } finally {
        busy.value = false
        reload()
      }
    }

    onMounted(() => {
      reload()
      const api = getSettingsApi()
      if (api && api.subscribe) {
        offConfig = api.subscribe((id, config) => {
          if (id !== props.pluginId) return
          values.value = config || {}
          tick.value++
        })
      }
      // 函数型字段可能反映异步任务的结果（如远程源更新），轻量轮询保证显示跟得上
      timer = setInterval(() => { tick.value++ }, 1000)
    })

    onBeforeUnmount(() => {
      if (timer) clearInterval(timer)
      if (offConfig) offConfig()
    })

    return {
      spec,
      busy,
      reload,
      textOf,
      suffixOf,
      itemsOf,
      valueOf,
      inputType,
      setValue,
      runAction,
    }
  },
}
</script>

<style module>
.panel { border-top: 1px dashed var(--border-color, #ddd); margin-top: 10px; padding-top: 10px; }
.head { display: flex; align-items: center; gap: 10px; margin-bottom: 8px; }
.headTitle { font-size: 13px; font-weight: 600; }
.headPath { font-size: 11px; color: var(--text-color-3, #aaa); }
.refreshBtn { margin-left: auto; background: transparent; border: 1px solid var(--border-color, #ccc); color: var(--text-color, #333); padding: 3px 10px; border-radius: 5px; cursor: pointer; font-size: 12px; }
.empty { font-size: 13px; color: var(--text-color-3, #aaa); padding: 6px 0; }
.row { padding: 6px 0; }
.divider { border: none; border-top: 1px solid var(--border-color, #eee); margin: 8px 0; }
.field { display: flex; flex-direction: column; gap: 4px; }
.switchRow { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; cursor: pointer; }
.label { font-size: 13px; color: var(--text-color, #333); }
.input { font-size: 13px; padding: 6px 8px; border: 1px solid var(--border-color, #ccc); border-radius: 5px; background: transparent; color: var(--text-color, #333); max-width: 320px; }
.textarea { font-size: 13px; padding: 6px 8px; border: 1px solid var(--border-color, #ccc); border-radius: 5px; background: transparent; color: var(--text-color, #333); min-height: 70px; resize: vertical; font-family: inherit; }
.suffix { font-size: 12px; color: var(--text-color-2, #888); }
.tip { font-size: 11px; color: var(--text-color-3, #aaa); line-height: 1.5; }
.infoRow { display: flex; align-items: center; gap: 10px; }
.infoText { font-size: 13px; color: var(--text-color, #333); }
.listWrap { display: flex; flex-direction: column; gap: 4px; }
.list { list-style: none; margin: 4px 0 0; padding: 0; display: flex; flex-direction: column; gap: 4px; }
.listItem { display: flex; align-items: baseline; gap: 8px; font-size: 12px; padding: 4px 8px; border: 1px solid var(--border-color, #eee); border-radius: 5px; }
.listName { font-weight: 600; color: var(--text-color, #333); }
.listDesc { color: var(--text-color-2, #888); word-break: break-all; }
.listStatus { margin-left: auto; color: var(--text-color-3, #aaa); }
.listEmpty { font-size: 12px; color: var(--text-color-3, #aaa); padding: 2px 0; }
.btnRow { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.btn { background: var(--primary-color, #4a8bf5); color: #fff; border: none; padding: 6px 14px; border-radius: 6px; cursor: pointer; font-size: 13px; }
.btn:disabled { opacity: .5; cursor: not-allowed; }
</style>
