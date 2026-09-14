<template>
  <div :class="$style.settingPlugins">
    <h3 :class="$style.title">插件管理</h3>
    <p :class="$style.desc">
      插件可覆盖或修改原程序功能（运行时包装原函数、注册音乐源、监听生命周期），
      卸载后自动还原，无需改动原代码。插件构建产物是<strong>单个文件</strong>（<code>.lxplugin</code>），
      上传即可安装 / 更新。
    </p>

    <div
      :class="[$style.drop, dragging ? $style.dropActive : null]"
      @dragover.prevent="dragging = true"
      @dragleave.prevent="dragging = false"
      @drop.prevent="handleDrop"
    >
      <div :class="$style.dropHint">把插件文件（.lxplugin）拖到这里即可安装</div>
      <div :class="$style.dropBtns">
        <button :class="$style.btn" :disabled="busy" @click="pickInstallFile">上传安装插件</button>
        <button :class="$style.btnGhost" :disabled="busy" @click="installFromDir">安装插件目录（本地开发）</button>
        <button :class="$style.btnGhost" :disabled="busy" @click="refresh">刷新</button>
      </div>
      <input ref="installInput" type="file" accept=".lxplugin,.js,.cjs" :class="$style.fileInput" @change="handleInstallFilePick" />
      <input ref="updateInput" type="file" accept=".lxplugin,.js,.cjs" :class="$style.fileInput" @change="handleUpdateFilePick" />
    </div>

    <p v-if="message" :class="[$style.msg, messageType === 'error' ? $style.msgErr : $style.msgOk]">{{ message }}</p>

    <div v-if="pending" :class="$style.confirm">
      <div :class="$style.confirmText">
        {{ pending.mode === 'install' ? '确认安装' : '确认更新' }}插件：
        <strong>{{ pending.manifest.name }}</strong>
        <span :class="$style.version">v{{ pending.manifest.version }}</span>
        <span :class="$style.confirmMeta">id: {{ pending.manifest.id }} · 端: {{ pending.manifest.platforms.join(' / ') }}</span>
        <span v-if="pending.mode === 'update'" :class="$style.confirmMeta">将覆盖已安装的 {{ pending.id }}</span>
      </div>
      <div :class="$style.actions">
        <button :class="$style.btn" :disabled="busy" @click="confirmPending">确认{{ pending.mode === 'install' ? '安装' : '更新' }}</button>
        <button :class="$style.btnGhost" :disabled="busy" @click="cancelPending">取消</button>
      </div>
    </div>

    <div v-if="loading" :class="$style.tip">加载中…</div>
    <div v-else-if="!list.length" :class="$style.tip">暂无已安装插件。上传一个 .lxplugin 文件即可安装。</div>

    <ul v-else :class="$style.list">
      <li v-for="p in list" :key="p.id" :class="$style.item">
        <div :class="$style.itemHead">
          <label :class="$style.switch">
            <input type="checkbox" :checked="p.enabled" @change="handleToggleEnable(p, $event)" />
            <span :class="$style.name">{{ p.name }}</span>
          </label>
          <span :class="$style.version">v{{ p.version }}</span>
          <span :class="[$style.status, statusClass(p.status)]">{{ statusText(p) }}</span>
        </div>
        <div :class="$style.meta">
          <span>id: {{ p.id }}</span>
          <span>端: {{ p.platforms.join(' / ') }}</span>
          <span v-if="p.author">作者: {{ p.author }}</span>
        </div>
        <div v-if="p.description" :class="$style.desc2">{{ p.description }}</div>
        <div v-if="p.error" :class="$style.err">{{ p.error }}</div>
        <div :class="$style.actions">
          <button :class="$style.btnSm" :disabled="busy" @click="pickUpdateFile(p)">上传新版本</button>
          <button :class="$style.btnSm" :disabled="busy" @click="updateFromDir(p)">目录更新（开发）</button>
          <button :class="$style.btnSm" :disabled="busy" @click="openDir(p)">打开目录</button>
          <button :class="$style.btnSmDanger" :disabled="busy" @click="uninstallPlugin(p)">卸载</button>
        </div>
        <div :class="$style.path" :title="p.dir">{{ p.dir }}</div>
      </li>
    </ul>
  </div>
</template>

<script>
import { ref, onMounted, onBeforeUnmount } from '@common/utils/vueTools'

export default {
  name: 'SettingPlugins',
  setup() {
    const list = ref([])
    const loading = ref(false)
    const busy = ref(false)
    const message = ref('')
    const messageType = ref('ok')
    const dragging = ref(false)
    // 待确认的上传：{ mode: 'install' | 'update', id, fileName, content, manifest }
    const pending = ref(null)
    const installInput = ref(null)
    const updateInput = ref(null)
    // 记录“上传新版本”时点击的是哪个插件
    let updateTargetId = ''

    // 宿主挂在 window.lx.plugins（带管理 API）
    const getHost = () => window.lx?.plugins
    const getManager = () => {
      const host = getHost()
      return (host?.manager) || null
    }
    /**
     * 插件宿主是异步初始化的：若启动后立刻进入设置页，管理 API 可能还没挂上。
     * 这里最多等待 3 秒，避免出现「列表为空且必须手动刷新」的假象。
     */
    const waitManager = async(timeout = 3000) => {
      const start = Date.now()
      while (Date.now() - start < timeout) {
        const mgr = getManager()
        if (mgr) return mgr
        await new Promise(resolve => { setTimeout(resolve, 100) })
      }
      return getManager()
    }

    const showMsg = (text, type = 'ok') => {
      message.value = text
      messageType.value = type
      setTimeout(() => { if (message.value === text) message.value = '' }, 5000)
    }

    const refresh = async() => {
      loading.value = true
      try {
        const mgr = await waitManager()
        if (!mgr) {
          showMsg('插件系统尚未就绪，请稍后重试', 'error')
          return
        }
        list.value = await mgr.list()
      } catch (err) {
        showMsg('获取插件列表失败：' + (err.message || err), 'error')
      } finally {
        loading.value = false
      }
    }

    /** 安装/更新后同步 renderer 端插件的加载状态 */
    const syncLoaded = async(id, enable) => {
      const host = getHost()
      if (!host || !id) return
      try {
        if (enable) await host.load(id)
        else await host.unload(id)
      } catch (err) {
        console.error('[plugin] 同步插件加载状态失败：', err)
      }
    }

    const pickInstallFile = () => {
      const el = installInput.value
      if (!el) return
      el.value = ''
      el.click()
    }

    const pickUpdateFile = p => {
      const el = updateInput.value
      if (!el) return
      updateTargetId = p.id
      el.value = ''
      el.click()
    }

    /** 读取用户选择的文件并生成待确认项（纯文本解析，不执行插件代码） */
    const prepareUpload = async(file, mode, id) => {
      const mgr = getManager()
      if (!mgr) return
      if (!file) return
      busy.value = true
      try {
        const content = await file.text()
        const res = mgr.inspect(file.name || '', content)
        if (!res.success) {
          showMsg(res.message || '插件文件解析失败', 'error')
          return
        }
        pending.value = { mode, id, fileName: file.name || '', content, manifest: res.manifest }
      } catch (err) {
        showMsg('读取插件文件失败：' + (err.message || err), 'error')
      } finally {
        busy.value = false
      }
    }

    const handleInstallFilePick = async event => {
      const file = event.target.files?.[0]
      await prepareUpload(file, 'install', '')
    }

    const handleUpdateFilePick = async event => {
      const file = event.target.files?.[0]
      await prepareUpload(file, 'update', updateTargetId)
    }

    const handleDrop = async event => {
      dragging.value = false
      const file = event.dataTransfer?.files?.[0]
      if (!file) return
      await prepareUpload(file, 'install', '')
    }

    const cancelPending = () => {
      pending.value = null
    }

    const confirmPending = async() => {
      const mgr = getManager()
      const task = pending.value
      if (!mgr || !task) return
      busy.value = true
      try {
        const res = task.mode === 'install'
          ? await mgr.installContent(task.fileName, task.content)
          : await mgr.updateContent(task.id, task.fileName, task.content)
        if (!res.success) {
          showMsg(res.message || '操作失败', 'error')
          return
        }
        pending.value = null
        showMsg(res.message || (task.mode === 'install' ? '安装成功' : '更新成功'))
        await refresh()
        if (res.id) await syncLoaded(res.id, true)
      } catch (err) {
        showMsg('操作失败：' + (err.message || err), 'error')
      } finally {
        busy.value = false
      }
    }

    const installFromDir = async() => {
      const mgr = getManager()
      if (!mgr) return
      busy.value = true
      try {
        const res = await mgr.installPick()
        if (!res.success) {
          if (res.message && res.message !== '已取消') showMsg(res.message, 'error')
          return
        }
        showMsg(res.message || '安装成功')
        await refresh()
        if (res.id) await syncLoaded(res.id, true)
      } catch (err) {
        showMsg('安装失败：' + (err.message || err), 'error')
      } finally {
        busy.value = false
      }
    }

    const updateFromDir = async p => {
      const mgr = getManager()
      if (!mgr) return
      busy.value = true
      try {
        const res = await mgr.updatePick(p.id)
        if (!res.success) {
          if (res.message && res.message !== '已取消') showMsg(res.message, 'error')
          return
        }
        showMsg(res.message || '更新成功')
        await refresh()
        if (res.id) await syncLoaded(res.id, true)
      } catch (err) {
        showMsg('更新失败：' + (err.message || err), 'error')
      } finally {
        busy.value = false
      }
    }

    const uninstallPlugin = async p => {
      const mgr = getManager()
      if (!mgr) return
      if (!confirm('确定卸载插件「' + p.name + '」？该操作会删除插件目录。')) return
      busy.value = true
      try {
        await syncLoaded(p.id, false)
        const res = await mgr.uninstall(p.id)
        if (!res.success) showMsg(res.message, 'error')
        else showMsg(res.message || '已卸载')
        await refresh()
      } catch (err) {
        showMsg('卸载失败：' + (err.message || err), 'error')
      } finally {
        busy.value = false
      }
    }

    const handleToggleEnable = async(p, event) => {
      const mgr = getManager()
      if (!mgr) return
      const enabled = event.target.checked
      busy.value = true
      try {
        const res = enabled ? await mgr.enable(p.id) : await mgr.disable(p.id)
        if (!res.success) {
          showMsg(res.message, 'error')
          await refresh()
          return
        }
        await syncLoaded(p.id, enabled)
        await refresh()
      } catch (err) {
        showMsg('操作失败：' + (err.message || err), 'error')
        await refresh()
      } finally {
        busy.value = false
      }
    }

    const openDir = async p => {
      const mgr = getManager()
      if (!mgr) return
      try {
        await mgr.openDir(p.id)
      } catch (err) {
        showMsg('打开目录失败：' + (err.message || err), 'error')
      }
    }

    const statusClass = s => {
      if (s === 'enabled') return 'sOk'
      if (s === 'error' || s === 'incompatible') return 'sErr'
      return 'sOff'
    }
    const statusText = p => {
      if (p.status === 'enabled') return '已启用'
      if (p.status === 'disabled') return '已禁用'
      if (p.status === 'error') return '出错'
      if (p.status === 'incompatible') return '不兼容'
      return p.status
    }

    // 避免把插件文件拖到窗口其它区域导致窗口跳转
    const preventWindowDrop = event => { event.preventDefault() }
    onMounted(() => {
      void refresh()
      window.addEventListener('dragover', preventWindowDrop)
      window.addEventListener('drop', preventWindowDrop)
    })
    onBeforeUnmount(() => {
      window.removeEventListener('dragover', preventWindowDrop)
      window.removeEventListener('drop', preventWindowDrop)
    })

    return {
      list,
      loading,
      busy,
      message,
      messageType,
      pending,
      dragging,
      installInput,
      updateInput,
      refresh,
      pickInstallFile,
      pickUpdateFile,
      handleInstallFilePick,
      handleUpdateFilePick,
      handleDrop,
      cancelPending,
      confirmPending,
      installFromDir,
      updateFromDir,
      uninstallPlugin,
      handleToggleEnable,
      openDir,
      statusClass,
      statusText,
    }
  },
}
</script>

<style module>
.settingPlugins { padding: 0 4px; }
.title { font-size: 16px; margin: 0 0 8px; }
.desc { font-size: 13px; color: var(--text-color-2, #888); line-height: 1.6; margin: 0 0 12px; }
.desc code { background: rgba(127,127,127,0.15); padding: 1px 5px; border-radius: 4px; }
.drop { border: 1px dashed var(--border-color, #ccc); border-radius: 10px; padding: 16px 12px; text-align: center; transition: background .15s, border-color .15s; }
.dropActive { border-color: var(--primary-color, #4a8bf5); background: rgba(74,139,245,.08); }
.dropHint { font-size: 13px; color: var(--text-color-2, #888); margin-bottom: 10px; }
.dropBtns { display: flex; gap: 8px; justify-content: center; flex-wrap: wrap; }
.fileInput { display: none; }
.btn { background: var(--primary-color, #4a8bf5); color: #fff; border: none; padding: 7px 14px; border-radius: 6px; cursor: pointer; font-size: 13px; }
.btnGhost { background: transparent; color: var(--text-color, #333); border: 1px solid var(--border-color, #ccc); padding: 7px 14px; border-radius: 6px; cursor: pointer; font-size: 13px; }
.btn:disabled, .btnGhost:disabled { opacity: .5; cursor: not-allowed; }
.msg { font-size: 13px; padding: 6px 10px; border-radius: 6px; margin: 10px 0; }
.msgOk { background: rgba(80,180,90,.15); color: #2f8f3a; }
.msgErr { background: rgba(220,80,80,.15); color: #c0392b; }
.confirm { border: 1px solid var(--primary-color, #4a8bf5); border-radius: 8px; padding: 10px 12px; margin: 10px 0; background: rgba(74,139,245,.06); }
.confirmText { font-size: 13px; line-height: 1.8; color: var(--text-color, #333); }
.confirmMeta { display: block; font-size: 12px; color: var(--text-color-2, #888); }
.tip { font-size: 13px; color: var(--text-color-3, #aaa); padding: 10px 0; }
.list { list-style: none; margin: 10px 0 0; padding: 0; display: flex; flex-direction: column; gap: 10px; }
.item { border: 1px solid var(--border-color, #e0e0e0); border-radius: 8px; padding: 10px 12px; }
.itemHead { display: flex; align-items: center; gap: 10px; }
.switch { display: flex; align-items: center; gap: 6px; cursor: pointer; }
.name { font-weight: 600; font-size: 14px; }
.version { font-size: 12px; color: var(--text-color-2, #888); }
.status { font-size: 12px; margin-left: auto; padding: 2px 8px; border-radius: 10px; }
.sOk { background: rgba(80,180,90,.18); color: #2f8f3a; }
.sOff { background: rgba(127,127,127,.18); color: #777; }
.sErr { background: rgba(220,80,80,.18); color: #c0392b; }
.meta { display: flex; gap: 14px; flex-wrap: wrap; font-size: 12px; color: var(--text-color-2, #888); margin-top: 6px; }
.desc2 { font-size: 13px; margin-top: 6px; color: var(--text-color, #444); }
.err { font-size: 12px; color: #c0392b; margin-top: 6px; }
.actions { display: flex; gap: 8px; margin-top: 10px; flex-wrap: wrap; }
.btnSm { background: transparent; border: 1px solid var(--border-color, #ccc); color: var(--text-color, #333); padding: 4px 10px; border-radius: 5px; cursor: pointer; font-size: 12px; }
.btnSmDanger { background: transparent; border: 1px solid #e0a0a0; color: #c0392b; padding: 4px 10px; border-radius: 5px; cursor: pointer; font-size: 12px; }
.btnSm:disabled, .btnSmDanger:disabled { opacity: .5; cursor: not-allowed; }
.path { font-size: 11px; color: var(--text-color-3, #aaa); margin-top: 8px; word-break: break-all; }
</style>
