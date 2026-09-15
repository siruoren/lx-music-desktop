<template>
  <div class="scroll" :class="$style.plugins">
    <!-- 独立的「插件管理」页面（侧边栏入口，路由 /plugins），内容复用 SettingPlugins -->
    <div :class="$style.inner">
      <SettingPlugins />
    </div>
  </div>
</template>

<script>
import SettingPlugins from './SettingPlugins.vue'

export default {
  name: 'Plugins',
  components: {
    SettingPlugins,
  },
}
</script>

<style lang="less" module>
.plugins {
  height: 100%;
  box-sizing: border-box;
  padding: 0 15px 15px;
  font-size: 14px;
}
.inner {
  padding-top: 15px;
}
</style>
