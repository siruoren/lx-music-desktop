<template lang="pug">
dt#network {{ $t('setting__network') }}
dd
  h3#network_proxy_title {{ $t('setting__network_proxy_title') }}
  div
    .p
      base-checkbox(id="setting_network_proxy_enable" :model-value="appSetting['network.proxy.enable']" :label="$t('setting__is_enable')" @update:model-value="updateSetting({'network.proxy.enable': $event})")
    .p
      label(:for="setting_network_proxy_type") {{ $t('setting__network_proxy_type') }}
      select#setting_network_proxy_type(:class="$style.select" :value="appSetting['network.proxy.type']" @change="setType($event.target.value)")
        option(value="http") HTTP
        option(value="socks5") SOCKS5
    .p
      base-input(:model-value="appSetting['network.proxy.host']" :placeholder="proxy.envProxy ? proxy.envProxy.host : $t('setting__network_proxy_host')" @update:model-value="setHost")
    .p
      base-input(:model-value="appSetting['network.proxy.port']" :placeholder="proxy.envProxy ? proxy.envProxy.port : $t('setting__network_proxy_port')" @update:model-value="setPort")

</template>

<script>
import { onBeforeUnmount } from '@common/utils/vueTools'
import { proxy } from '@renderer/store'
import { debounce } from '@common/utils'

import { appSetting, updateSetting } from '@renderer/store/setting'

export default {
  name: 'SettingNetwork',
  setup() {
    const setHost = debounce(host => {
      updateSetting({ 'network.proxy.host': host.trim() })
    }, 500)
    const setPort = debounce(port => {
      updateSetting({ 'network.proxy.port': port.trim() })
    }, 500)
    const setType = debounce(type => {
      updateSetting({ 'network.proxy.type': type as 'http' | 'socks5' })
    }, 300)

    onBeforeUnmount(() => {
      if (appSetting['network.proxy.enable'] && !appSetting['network.proxy.host']) proxy.enable = false
    })

    return {
      appSetting,
      updateSetting,
      setHost,
      setPort,
      setType,
      proxy,
    }
  },
}
</script>

<style lang="less" module>
@import '@renderer/assets/styles/layout.less';

.select {
  display: block;
  width: 100%;
  border: none;
  border-radius: @form-radius;
  padding: 7px 8px;
  color: var(--color-button-font);
  outline: none;
  transition: background-color 0.2s ease;
  background-color: var(--color-primary-background);
  font-size: 13.3px;

  &:hover, &:focus {
    background-color: var(--color-primary-background-hover);
  }
  &:active {
    background-color: var(--color-primary-background-active);
  }
}
</style>
