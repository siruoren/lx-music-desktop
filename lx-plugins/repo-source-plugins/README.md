# repo-source-plugins

`lx-plugins` 插件项目下的一个插件项目（目录名即插件 id / 名称 / 构建产物名）。

## 功能

为音乐搜索提供**同源结果去重 + 累计统计**：

- 同一个音乐源内部会返回重复条目（同名 / 同歌手 / 同专辑 / 同时长），插件在
  `musicSdk.searchMusic` 的返回值上做一次稳定去重，保持原有顺序；
- 只做**同一音乐源内部**去重，不跨源合并，避免丢失其它源里的可用结果；
- 去重条数写入插件私有存储（累计），并在控制台输出 `[plugin:repo-source-plugins]` 日志；
- 在「设置 → 插件管理」里禁用或卸载后，`musicSdk.searchMusic` 立即还原，行为与原程序一致。

插件同时演示了插件 API 的三项能力：`api.patch`（运行时包装原函数）、`api.hooks.on`（生命周期）、
`api.getData/setData`（私有持久化）。

## 构建

```bash
npm run build:plugin
```

产物：`lx-plugins/repo-source-plugins/dist/repo-source-plugins.lxplugin`（单个文件）。

构建脚本零依赖，逻辑见 [`build.js`](./build.js)：读取 `plugin.json` → 取入口代码 →
在最前面套一个 `/*!lxplugin ... */` 横幅（内嵌清单）→ 写出单个 `.lxplugin`。
横幅是合法 JS 注释，因此产物本身也是可执行的 JS 模块；安装阶段只解析清单文本、不执行代码。

## 安装

客户端「设置 → 插件管理」：

- 点「上传安装插件」选择 `.lxplugin` 文件，或把文件**拖拽**到虚线框内；
- 插件列表里点「上传新版本」可上传更高版本的 `.lxplugin` 完成更新；
- 也可用「安装插件目录（本地开发）」直接选择本目录（开发调试用，免构建）。

## 入口代码约定

```js
module.exports = {
  setup(api) {},          // 启用/加载时调用，拿到插件 API
  uninstall() {},         // 禁用/卸载时调用（宿主还会自动回退 patch 与 hooks）
  onUpdate(oldVersion) {},// 更新到新版本后调用
}
```

单文件插件的模块代码必须是**自包含的 CommonJS**：产物里没有同级依赖文件，
如需第三方依赖请先用打包器（esbuild / rollup / webpack）内联成一个文件，
再用 `plugin.json` 的 `build.entry` 指向该文件：

```json
{ "main": "index.js", "build": { "entry": "dist/bundle.js" } }
```

`build.entry` 仅在构建期使用，不会写入产物的插件清单。
