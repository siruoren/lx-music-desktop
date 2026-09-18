# 插件开发指南

lx-music-desktop（本 fork）插件系统的**开发参考手册**。想写一个插件、或想搞清楚插件系统到底能干什么，看这一篇就够了。

> **文档分工**（避免同一件事写两遍）
>
> | 文档 | 定位 |
> | --- | --- |
> | 本文件 `lx-plugins/DEVELOPMENT.md` | **框架能力的权威参考**：清单字段、生命周期、API 语义、存储、调试、限制 |
> | [`lx-plugins/README.md`](./README.md) | 目录索引：这里有什么插件、怎么构建、怎么发布（CI/Pre-release） |
> | `lx-plugins/<项目>/README.md` | 单个插件自己的说明（功能、配置项、实现要点） |
> | `../src/plugins/*.ts` | 运行时实现（宿主、管理器、加载器、格式、校验…），每文件顶部有设计说明 |
>
> ⚠️ **框架新增/变更能力时必须同步更新本文**——具体清单见文末[第 10 节](#10-文档同步约定)。

---

## 1. 30 秒上手

```bash
# 1) 新建插件项目目录（目录名 = 插件 id / 产物名）
mkdir lx-plugins/hello && cd lx-plugins/hello

# 2) 写清单 plugin.json
#    { "id": "hello", "name": "hello", "platforms": ["renderer"] }

# 3) 写入口 index.js
#    module.exports = { setup(api) { api.logger.info('hello') } }

# 4) 构建（零依赖，不需要 npm install）
cd ../.. && node lx-plugins/repo-source-plugins/build.js hello
# 产物：lx-plugins/hello/dist/hello-<app 版本>.lxplugin   例如 hello-2.12.5.lxplugin
#（npm run build:plugin 等价于 build.js --all，会构建全部插件项目）
```

然后在客户端侧边栏「**插件管理**」里「上传安装插件」（或把文件**拖拽**到虚线框内）即可。

开发期更快的路子：**跳过构建**，直接点「**安装插件目录（本地开发）**」选 `lx-plugins/hello/` 目录，
改完代码用「**目录更新（开发）**」重新拉一次（注意版本号约束，见 [9.2](#92-已知缺陷--坑)）。

---

## 2. 架构总览

插件系统分两个进程运行，**两端能力不同、钩子总线也相互独立**：

```
┌─ main 进程 ───────────────────────────────┐   ┌─ renderer 进程 ─────────────────────────┐
│ src/plugins/main.ts   initPluginManager() │   │ src/plugins/renderer.ts initUserPlugins()│
│   ├─ PluginManager  安装/卸载/更新/启停    │   │   ├─ 向 main 要「可加载的 renderer 插件」│
│   ├─ HookBus(main)  PatchManager(main)    │   │   ├─ IPC 取回入口源码 → loader 求值      │
│   └─ HostContext     data.json / 会话代理  │   │   ├─ HookBus(renderer) PatchManager(r)   │
│                                           │   │   └─ HostContext  localStorage / 音乐源  │
│ global.lx.plugins ← 宿主 API              │   │ window.lx.plugins ← 宿主 API             │
└───────────────────────────────────────────┘   └─────────────────────────────────────────┘
        ▲  IPC（src/plugins/ipc.ts，plugin:*）              │
        └──────────────────────────────────────────────────┘
```

- **`platforms` 不含 `main`** 的插件永远不会在 main 进程执行；反之亦然。
- 渲染端插件由 **main 读源码、renderer 求值执行**（因为插件文件只存在于 `userData` 下，webpack 无法静态分析，故不走 `import()`）。
- `api.hooks.emit()` **不跨进程**：main 端 `emit` 只有 main 端插件能收到。需要跨进程通信请自行走 IPC。

### 关键文件职责

| 文件（`src/plugins/`） | 职责 |
| --- | --- |
| `main.ts` | main 宿主：初始化、注册 `plugin:*` IPC、加载 main 端插件、`global.lx.plugins` |
| `renderer.ts` | renderer 宿主：加载 renderer 端插件、`window.lx.plugins`、音乐源/设置面板/`listData`/`userApi` 桥 |
| `manager.ts` | 插件管理器：扫描列表、安装、卸载、更新、启用/禁用、状态判定 |
| `loader.ts` | 用 `new Function` 在 CommonJS 语义下求值插件代码 |
| `host.ts` | 构造每个插件专属的 `PluginApi`（记录 patch / 订阅，供卸载时回退） |
| `hookBus.ts` | 钩子总线（事件 + 拦截链） |
| `patch.ts` | 运行时函数包装器（可多插件叠加、可精确还原） |
| `format.ts` | `.lxplugin` 单文件格式解析 / 生成 |
| `validate.ts` / `manifest.ts` / `semver.ts` | 清单校验、磁盘读取、版本比较 |
| `storage.ts` | `enabled.json`（启用状态）与 `<插件目录>/config.json`（插件配置） |
| `sessionProxy.ts` | Chromium 会话代理接管（让「播放」也走代理） |
| `ui/Plugins.vue` · `ui/SettingPlugins.vue` · `ui/PluginSettingsPanel.vue` | 插件管理页（侧边栏「插件管理」）与通用设置面板 |

### 一次插件的完整生命周期

```
上传 .lxplugin ──▶ 只解析横幅清单（不执行代码）──▶ 写入 userData/plugins/<id>/
   └─ 默认即「启用」（enabled.json 未记录 = 启用）
        └─ 按 platforms 分发：
             main     → main 进程立即求值并 setup()
             renderer → 下一次宿主加载时（启动 / 启用 / 安装后 UI 主动 load）求值并 setup()
                  └─ hooks.emit('app:ready')
  禁用/卸载 ──▶ module.uninstall() ──▶ 宿主自动回退 patch + 反订阅 hooks ──▶ 上报状态
```

### 磁盘布局

```
<userData>/plugins/
├── enabled.json            各插件启用开关（未记录 = 启用）
└── <插件 id>/
    ├── plugin.json         清单
    ├── index.js            入口（main 字段指定，默认 index.js）
    ├── config.json         插件配置（api.getConfig/setConfig、设置面板）— 更新时保留
    └── data.json           main 端的 api.getData/setData          — 更新时保留
```

---

## 3. 清单 `plugin.json`

```json
{
  "id": "com.example.my-plugin",
  "name": "我的插件",
  "description": "一句话说明（会显示在插件管理页）",
  "author": "your-name",
  "homepage": "https://github.com/you/repo",
  "main": "index.js",
  "platforms": ["main", "renderer"],
  "engines": { "app": ">=2.0.0" },
  "build": { "entry": "src/bundle.js" }
}
```

| 字段 | 必填 | 说明 |
| --- | --- | --- |
| `id` | ✅ | 全局唯一，**同时用作插件目录名**。只允许字母/数字/`.`/`_`/`-`，且以字母或数字开头，≤128 字符。建议反向域名 |
| `name` | ✅ | 展示名称（可中文） |
| `version` | ✅ | 形如 `1.0.0`。**构建时会被 app 版本覆盖**（见下） |
| `main` | | 入口文件名，默认 `index.js`。**必须是不含路径分隔符的简单文件名**，以 `.js/.cjs/.mjs` 结尾 |
| `platforms` | | `"main"` / `"renderer"`，默认 `["renderer"]` |
| `engines.app` | | 最低客户端版本，如 `>=2.0.0`。支持 `>=` `>` `<=` `<` `^` 与精确匹配，**只支持单个约束**（没有 `&&`/`\|\|`） |
| `description` / `author` / `homepage` | | 展示用 |
| `build.entry` | | **仅构建期使用**，指定源码入口（可指向打包产物），不会写入产物清单 |

### 版本号：插件版本 ≡ app 版本

构建脚本从**仓库根 `package.json`** 读 `version` 并注入产物横幅，`plugin.json` 里写的 `version` 会被忽略（不一致时会打提示）。所以：

- **不需要**发版时逐个改插件版本号；
- 产物文件名也带这个版本号（`<插件名>-<版本>.lxplugin`，如 `sock_proxy-2.12.5.lxplugin`）；
- 反过来说：**同一次 app 版本下，插件的版本号不会变**，这会直接影响「更新」的判定（见 [9.2](#92-已知缺陷--坑)）。

---

## 4. 入口模块与生命周期

入口是**自包含的 CommonJS**，用 `new Function('module','exports','require','__filename','__dirname', code)` 求值：
不支持顶层 `import` / ESM 语法；`__filename` 在 main 端为入口绝对路径、renderer 端为入口文件名；`__dirname` main 端为插件目录、renderer 端为空字符串。

```js
'use strict'

module.exports = {
  /** 加载/启用时调用，拿到插件 API（可 async） */
  setup(api) {},

  /** 禁用/卸载时调用：清理定时器、连接、自己摘掉的监听等 */
  uninstall() {},

  /** 更新到新版本后调用（⚠️ 目前只有 main 端插件会收到） */
  onUpdate(oldVersion) {},

  /** 配置被写入后调用（设置面板改完立即生效的关键） */
  onConfigChange(config) {},

  /** 设置面板上的按钮被点击（action = 字段里声明的动作名） */
  onSettingsAction(action, config) {},
}
```

其它被兼容的导出形式：

| 写法 | 等价于 |
| --- | --- |
| `module.exports = function (api) {}` | 只提供 `setup` |
| `exports.default = { setup, ... }` | 打包器 ESM→CJS 互操作时常见，自动取 `.default` |

### 生命周期回调表

| 回调 | 何时调用 | 备注 |
| --- | --- | --- |
| `setup(api)` | 插件被加载（启动 / 启用 / 安装后 UI 主动 load） | 可 async，宿主会 await；抛错 → 状态显示「出错」并给出原因 |
| `uninstall()` | 禁用 / 卸载 / **更新前**（先卸载旧版本） | 在宿主回退 patch **之前**执行 |
| `onUpdate(oldVersion)` | 更新完成后 | ⚠️ 只有 `platforms` 含 `main` 且重新加载成功时触发；renderer 端插件拿不到 |
| `onConfigChange(config)` | `config.json` 被写入之后（面板改配置、插件自己 `setConfig`） | main / renderer 两端都会触发 |
| `onSettingsAction(action, config)` | 点击设置面板按钮 | 仅渲染端有面板 |

### 零残留：卸载时宿主替你回退

`uninstall()` 之后宿主会自动：

1. 把所有 `api.patch` 的包装**还原为原函数对象**；
2. 反订阅所有通过 `api.hooks.on/once/intercept` 注册的监听。

所以正常情况下**不需要**手写回退逻辑；只有你自己在插件里做的副作用（定时器、`require('electron')` 上手动 `removeAllListeners`、监听 `window` 事件）才需要显式清理。

---

## 5. 插件 API 参考

`setup(api)` 里的 `api` 由 `host.ts` 按进程注入，签名见 `src/plugins/types.ts`。

### 5.1 通用成员

| 成员 | 说明 |
| --- | --- |
| `api.id` / `api.version` / `api.platform` | 插件 id / 版本 / `'main' \| 'renderer'` |
| `api.dir` | **仅 main 端**为插件目录绝对路径；renderer 端为空字符串 |
| `api.app` | main 端 = `global.lx`；renderer 端 = `window.lx` |
| `api.logger.info/warn/error` | 统一带 `[plugin:<id>]` 前缀输出 |

### 5.2 能力矩阵（哪些能力在哪端可用）

| 能力 | main | renderer |
| --- | :---: | :---: |
| `api.patch` / `api.unpatch` | ✅ | ✅ |
| `api.hooks`（事件 / 拦截） | ✅ | ✅（**独立总线，不跨进程**） |
| `api.getData` / `api.setData` | ✅ `data.json` | ✅ `localStorage` |
| `api.getConfig` / `api.setConfig` | ✅ | ✅（同一份 `config.json`） |
| `api.registerSettings` | ❌ | ✅ |
| `api.registerMusicSource` / `unregisterMusicSource` | ❌ | ✅ |
| `api.setSessionProxy` | ✅ | ❌ |
| `api.electron` | ✅ | ❌ |
| `api.setTouchBar` | ✅（仅 macOS 生效） | ❌ |
| `api.controlPlayer` | ✅ | ❌ |
| `require('...')` | ✅ `createRequire(入口)`：能加载插件目录内文件与 node 内置模块 | ✅ `window.require`（主窗口 `nodeIntegration: true`） |
| 用 `window` / `document` | ❌ | ✅ |

### 5.3 `api.hooks` —— 事件与拦截

```js
// 事件：监听（返回取消函数）
const off = api.hooks.on('app:ready', () => { /* app 与其它插件都就绪 */ })
api.hooks.once('plugin:loaded', payload => {})
api.hooks.emit('my-plugin:something', data)   // 发射自定义事件（同进程内共享）

// 拦截：责任链，可改写 ctx 或直接短路（不调 next 即“覆盖”）
api.hooks.intercept('search:before', (ctx, next) => { ctx.args.keyword = ctx.args.keyword.trim(); return next(ctx) })
api.hooks.run('search:before', ctx, c => doOriginal(c))  // 发射方用法
```

**宿主内置事件**（其它名字都需要你自己 `emit`/`run`）：

| 事件 | 何时发 | 载荷 |
| --- | --- | --- |
| `app:ready` | main：所有已启用的 main 端插件加载完之后；renderer：所有 renderer 端插件加载完之后 | 无 |
| `plugin:loaded` | 每个插件加载成功 | main: `{ id, manifest }`；renderer: `{ id }` |
| `plugin:unloaded` | 插件被卸载/禁用后 | `{ id }` |

> **现状提示**：宿主自身目前**没有内置任何 `intercept` 拦截点**（`hooks.run(...)` 在 app 源码里没有调用处）。
> `intercept/run` 是一套**可用的机制**，用于后续新增扩展点、或插件之间约定协作；
> 想改原程序行为，现在请用 `api.patch`（见下）。

### 5.4 `api.patch` —— 运行时覆盖原功能

```js
api.patch(ipcRenderer, 'send', (next, channel, ...args) => {
  if (channel === 'update_check') return        // 不调 next = 完全覆盖
  return next(channel, ...args)                 // 调 next = 前后增强
})
```

- `wrapper(next, ...args)`，`next` 是**原实现**（多插件叠加时为上一层包装）。
- 卸载/禁用时自动还原，**源码零改动**。
- ⚠️ 注意事项：
  1. `target[method]` 必须已经是函数，否则抛错；
  2. 若原作**提前把函数引用取走**（解构 / 闭包捕获 / 已 bind），包装不会生效 —— 换个切入点（更上层、或该函数的调用方）；
  3. **`api.unpatch(target, method)` 不传 `wrapper` 时会把该方法上的所有包装一起移除**（含其它插件的），且本插件其余 patch 会失去追踪、卸载时不回退 —— **务必总是传 `wrapper`**（见 [9.2](#92-已知缺陷--坑)）。

### 5.5 `api.getData` / `api.setData` —— 私有键值存储

| 端 | 位置 | 说明 |
| --- | --- | --- |
| main | `<插件目录>/data.json` | 读取键不存在时返回默认值；**更新插件时保留** |
| renderer | `localStorage` 的 `plugin:<id>:<key>` | 值为 JSON 序列化；**卸载不会自动清理**（需要清理请在 `uninstall` 里显式覆盖） |

### 5.6 `api.getConfig` / `api.setConfig` —— 插件配置（与设置面板共用）

- 实体固定为 `<插件目录>/config.json`，**与 app 自身设置完全隔离**，**更新插件时保留**。
- renderer 端在内存里保有一份副本，因此 `getConfig()` 是**同步**的；`setConfig(patch)` 是合并写入（先更内存、再异步落盘），并触发 `onConfigChange`。
- 面板字段上声明的 `default` 只在**读取时**补齐、不会写回文件。

### 5.7 `api.registerSettings` —— 声明式设置面板（仅 renderer）

插件**不用自带 Vue 组件**：声明字段，宿主用 `ui/PluginSettingsPanel.vue` 统一渲染。
这样产物仍是单个文件，也避免插件代码进入 webpack 编译链。

```js
api.registerSettings({
  title: '我的插件设置',
  fields: [
    { type: 'divider' },
    { type: 'text', key: 'host', label: '服务器地址', placeholder: 'https://…', default: '' },
    { type: 'password', key: 'token', label: '令牌' },
    { type: 'number', key: 'port', label: '端口', default: 443 },
    { type: 'switch', key: 'autoSync', label: '启动时自动同步', default: false },
    { type: 'textarea', key: 'scope', label: '同步范围', tip: '逗号分隔：love,user' },
    { type: 'buttons', buttons: [ { label: '立即执行', action: 'run' }, { label: '测试连接', action: 'test' } ] },
    { type: 'button', label: '单独一个按钮', action: 'ping' },
    { type: 'info', text: () => `上次更新：${api.getConfig().lastRun || '从未'}`, suffix: () => '（实时）' },
    { type: 'list', label: '已导入的源', items: () => api.getData('ledger', []) },
  ],
})
```

| 字段类型 | 渲染 | 关键属性 |
| --- | --- | --- |
| `switch` | 复选框 | `key`、`default`；**改动立即落盘** |
| `text` / `password` / `number` | 单行输入 | `key`、`placeholder`、`default` |
| `textarea` | 多行输入 | 同上 |
| `info` | 只读文本 | `text`（可传函数）、`suffix`（可传函数） |
| `button` | 单个按钮（独占一行） | `label`、`action`、`disabled` |
| `buttons` | **一行多个按钮** | `buttons: [{ label, action, disabled }]` |
| `list` | 只读条目列表 | `label`、`items: () => [{ name, desc, status }]`、`tip` |
| `divider` | 分隔线 | 无 |

通用属性：`label`、`tip`（控件下方小字）、`suffix`（右侧附加文字）、`disabled`。
`text` / `items` / `suffix` **允许传函数，每次渲染求值**（面板每秒轻量轮询），所以能显示实时状态。

行为细节（写面板时值得知道）：

- 文本类字段输入**防抖 500ms** 落盘，**失焦/回车立即落盘**；未落盘的草稿在点按钮或收起面板前会被一次性冲刷；
- 点按钮 → 宿主执行 `module.onSettingsAction(action, config)`，执行期间按钮显示「处理中…」并禁用；
- 面板里同名 `key` 的字段读到的是同一份 `config.json`。

### 5.8 `api.registerMusicSource` —— 注册音乐源（仅 renderer）

```js
api.registerMusicSource('my-source', '我的源', { /* musicSdk 源模块：musicSearch / songList / ... */ })
```

- 注册后**参与跨源搜索**（`musicSdk.searchMusic`），并同时挂到 `musicSdk[id]`（播放地址 / 歌词 / 封面等既有代码路径靠 `musicSdk[source]` 取模块）；卸载自动移除。
- ⚠️ **UI 的「每源列表」不会有条目**：`store/search`、排行榜、热搜等在**模块加载期**就遍历 `music.sources`，插件注册晚于它们。排行榜 / 歌单 / 热搜类接口因此不会被调用。
- ⚠️ `id` 与已有音乐源或 `musicSdk` 上的既有属性冲突时**静默忽略**（只打 warning）。
- `unregisterMusicSource(id)` 只回收插件系统注册过的 id，内置源不会被删。

### 5.9 `api.setSessionProxy(rules | null)` —— Chromium 会话代理（仅 main）

让 `<audio>` 播放、`<img>` 封面等**由 Chromium 直接发起**的请求也走代理。详见 README 的「[代理为什么有两层](./README.md#代理为什么有两层重要)」——
简单说：**只接管 Node 的 http.Agent，播放依然直连**，必须两层都覆盖。传 `null` 撤销接管、回到 app 自身的网络代理。

### 5.10 `api.electron` / `api.setTouchBar` / `api.controlPlayer` —— Touch Bar 与播放控制（仅 main）

Touch Bar 是 Electron **主进程**专属 GUI，必须在主进程构造并经 `win.setTouchBar()` 设置；
按钮点击再向 renderer 发播放控制指令、并接收播放状态回显。这三个能力配合即可做出
「在 Touch Bar 上控制播放」的插件（参考 `lx-plugins/touch_bar`）。

```js
// platforms: ['main'] 的插件里
// 注意：TouchBarButton / TouchBarLabel / TouchBarSpacer 是 TouchBar 类的**静态成员**，
// 不是 electron 的顶层导出——必须从 TouchBar 上取，否则 new 时抛 "TouchBarLabel is not a constructor"。
const { TouchBar } = api.electron
const { TouchBarButton, TouchBarLabel, TouchBarSpacer } = TouchBar

// 扁平图标：用 nativeImage 现画、并 setTemplateImage(true)。
// template image 只认 alpha 通道、颜色被系统统一为外观色 → 扁平、自动适配浅/深色；
// 按钮只设 icon 不设 label，图标占据整个按钮、视觉更大更干净（贴近官方 Music app）。
// TouchBarButton 的图标尺寸由系统固定、无法再放大，故让图形尽量填满画布以最大化显示。
// 下面用纯 Node zlib 把 RGBA 编码成 PNG（无需任何 npm 依赖）：
const { deflateSync } = require('zlib')
function pngFromRGBA(w, h, rgba) { /* ... deflate 扫描线 → PNG ... */ }
function makeIcon(draw) {
  const buf = Buffer.alloc(48 * 48 * 4)               // 透明画布
  const cv = { set(x, y) { /* 写 alpha=255 */ }, /* rect / tri 等 */ }
  draw(cv)
  const img = api.electron.nativeImage.createFromBuffer(pngFromRGBA(48, 48, buf))
  img.setTemplateImage(true)
  return img
}
const playIcon = makeIcon((c) => c.tri(16, 10, 16, 38, 38, 24))   // 右向三角
const pauseIcon = makeIcon((c) => { c.rect(15, 10, 7, 28); c.rect(26, 10, 7, 28) })

// TouchBarLabel 支持 fontSize（放大文字），TouchBarButton 不支持字号（系统固定）。
// 要做“大字”，用 TouchBarLabel；按钮只能靠文字/图标标签，字号不可调。
const lyricLabel = new TouchBarLabel({ label: '未播放', fontSize: 16 })
const playBtn = new TouchBarButton({
  icon: playIcon,
  click: () => api.controlPlayer(isPlaying ? 'pause' : 'play'),
})
const touchBar = new TouchBar({ items: [prevBtn, playBtn, nextBtn, new TouchBarSpacer({ size: 'flexible' }), lyricLabel] })
api.setTouchBar(touchBar)                 // 挂到主窗口；窗口未就绪时自动挂起、就绪后应用

// 订阅播放状态（与任务栏缩略图按钮共用同一路广播）
api.app.event_app.on('player_status', ({ status, name, singer, collect, lyricLineText }) => {
  playBtn.icon = status === 'playing' ? pauseIcon : playIcon   // 播放/暂停换图标
  // 歌词优先；无歌词回退到歌名；都不带时保持“未播放”
  // 长歌词可自己做 marquee：每隔 250ms 平移 lyricLabel.label 一个字符窗口（循环），
  // 期间只改 .label 不重挂 TouchBar，避免闪烁；离散变化（切歌/换词）才重挂一次。
  lyricLabel.label = (lyricLineText || (name ? `${name} - ${singer}` : '未播放'))
  api.setTouchBar(touchBar)               // 改动后重挂一次更稳妥
})
```

> **Touch Bar 的「后台常驻」限制（重要）**：macOS 的 Touch Bar 永远显示**当前最前台 App** 的内容。
> `api.setTouchBar` 把自定义 Touch Bar 挂在主窗口上，只要 lx-music 是前台 App（即便窗口最小化）就会显示；
> 一旦切到其它 App，显示的是那个 App 的 Touch Bar——这是系统行为，单靠 `setTouchBar` 无法突破。
> 若要做到「像官方 Music app 那样切到别的 App 也常驻媒体控件」，需接入**系统级 Now Playing**
> （macOS 的 `MPNowPlayingInfoCenter` / Chromium 的 `navigator.mediaSession`），属 App 层能力，需另立项，
> 不在插件框架范围内。

- `api.electron`：宿主注入的主进程 `electron` 模块（`import * as Electron from 'electron'` 的命名空间），用于取 `TouchBar` 等原生类。**仅 main 端**。**坑**：`TouchBarButton` / `TouchBarLabel` / `TouchBarSpacer` 是 `TouchBar` 的静态成员（即 `electron.TouchBar.TouchBarButton`），不是 `electron` 的顶层导出，务必 `const { TouchBarButton } = TouchBar`，直接 `electron.TouchBarButton` 会是 `undefined`。
- `api.setTouchBar(touchBar | null)`：把 Touch Bar 挂到主窗口；传 `null` 移除。**仅 macOS 生效**（其它平台为 no-op）。窗口尚未创建时挂起、在 `ready-to-show` 自动应用，并在窗口重建后重新应用，因此插件无需关心窗口时序。
- `api.controlPlayer(action, data?)`：向 renderer 发播放控制指令，**复用任务栏缩略图按钮通道**，`action` 取值同任务栏：`play` / `pause` / `prev` / `next` / `collect` / `unCollect` / `seek` / `mute` / `volume`。**仅 main 端**。
- 播放状态来自 `api.app.event_app.on('player_status', cb)`（main 端事件总线，EventEmitter）；`status` 取 `'playing' | 'paused' | 'stoped' | 'error'`，并带以下字段：
  - `name` / `singer` / `albumName` / `picUrl`：曲目信息（切歌时带，进度/seek 事件不带，别据此清空标题）。
  - `collect`：是否已收藏（boolean）。
  - `progress` / `duration`：播放进度 / 总时长（秒）。
  - `lyricLineText`：**当前歌词行**（renderer 在 `lyricLinePlay` 时广播，单行、不含换行）；`lyricLineAllText`：当前行 + 扩展（翻译）以 `\n` 连接。空串表示暂无（如间奏），应回退到 `name`。
  - `lyric` / `tlyric` / `rlyric` / `lxlyric`：整首歌词原文（切歌/歌词更新时带），一般无需在 Touch Bar 上整首显示。

> 底层：`src/plugins/winBridge.ts` 是注册式桥——`winMain/main.ts` 在窗口创建后 `registerMainWindowBridge({ getWindow, controlPlayer })`，插件宿主把 `api.setTouchBar` / `api.controlPlayer` 转发过去。用注册回调而非直接 import `winMain` 是为了避免循环依赖。

---

## 6. 宿主扩展点（比 `api` 更底层）

### 6.1 `window.lx.plugins` / `global.lx.plugins`

| 成员 | 用途 |
| --- | --- |
| `manager.list() / inspect(fileName, content)` | 列出插件 / **纯文本预解析**上传内容（不执行代码），可用于上传前预览 |
| `manager.installContent / installFilePick / installPick / installPath` | 安装（单文件内容 / 弹窗选文件 / 弹窗选目录 / 指定目录） |
| `manager.updateContent / updateFilePick / updatePick / updatePath` | 更新（同上四种） |
| `manager.uninstall / enable / disable / openDir` | 卸载 / 启用 / 禁用 / 打开插件目录 |
| `load(id) / unload(id) / isLoaded(id)` | renderer 端插件的热加载 / 热卸载（**renderer 端独有**，UI 启停后会调用） |
| `settings.get / has / getConfig / setConfig / runAction / subscribe` | 设置面板数据面（面板组件用的就是它） |
| `userApi.list / refresh / importScript / remove / getActiveId / setActiveId` | 桥接 app 的「自定义源」（导入 / 移除 / 当前勾选） |
| `listData.exportAll(scope?) / importAll(lists, scope?)` | 桥接「我的列表」（试听列表 / 我的收藏 / 歌单），详见 [7.4](#74-读写我的列表收藏) |

### 6.2 其它全局点

| 全局 | 说明 |
| --- | --- |
| `window.lx.musicSdk` | 音乐源 SDK 本体，`api.patch` 覆盖搜索 / 列表等功能的常用目标 |
| `window.lx.pluginMusicSources` | 插件注册的音乐源 Map（宿主内建，插件一般不需要直接碰） |
| `window.lx.pluginNetAgent` | `(url, proxyOptions) => agent \| undefined`，接管音乐源 API 请求的 http.Agent；未装相关插件时为 `null`（行为与上游一致） |
| `global.lx`（main） | app 主进程的全局对象，main 端插件的 `api.app` |

---

## 7. 常见配方

### 7.1 包装一个异步原函数

```js
setup(api) {
  const sdk = window.lx.musicSdk
  api.patch(sdk, 'searchMusic', (next, keyword, page, type) => {
    const result = next(keyword, page, type)
    if (result && typeof result.then === 'function') return result.then(trim)
    return trim(result)
  })
}
```

### 7.2 启动后做一次初始化

```js
api.hooks.on('app:ready', () => { void sync() })
```

`app:ready` 在所有插件（含自己）都 setup 完之后才发，适合做「读配置 → 联网 → 写回状态」这类工作。

### 7.3 定时任务（务必在卸载时清理）

```js
let timer = null
module.exports = {
  setup(api) {
    timer = setInterval(() => { void sync(api) }, 30 * 60 * 1000)
  },
  uninstall() { if (timer) { clearInterval(timer); timer = null } },
}
```

### 7.4 读写「我的列表」（收藏）

渲染端收藏存在 SQLite（`lx.data.db`），且读写必须走 store action —— 这些 action 没挂在 `window.lx` 上，
所以由宿主桥接成 `window.lx.plugins.listData`：

```js
// scope：'default' 试听列表 / 'love' 我的收藏 / 'user' 歌单；不传或 'all' = 全部
const lists = await window.lx.plugins.listData.exportAll('love,user')   // [{ ...list, list: [歌曲…] }, …]
await window.lx.plugins.listData.importAll(lists, 'love,user')
```

- 导出格式与「设置 → 备份」一致：`[{ ...列表元信息, list: [歌曲…] }, …]`；
- `importAll` 对**未选中类别会读回当前内容再回填**，所以不会误清空没勾选的列表。

### 7.5 编译期注意

单文件插件的产物里**没有同级依赖文件**，入口代码必须自包含。要引第三方库，先用打包器内联：

```json
{ "main": "index.js", "build": { "entry": "dist/bundle.js" } }
```

构建脚本检测到 `require(` 会提示你确认依赖是否已内联。

---

## 8. 本地开发与调试

| 目的 | 做法 |
| --- | --- |
| 免构建调试 | 「安装插件目录（本地开发）」选 `lx-plugins/<项目>/`；改完点「目录更新（开发）」 |
| 单文件流程 | `npm run build:plugin` → 「上传新版本」 |
| 看日志 | 控制台搜 `[plugin:<id>]`（你的 `api.logger.*` 输出都带这个前缀） |
| 看插件目录 | 插件管理页每行末尾显示 `dir`，或用「打开目录」 |
| 确认状态 | 状态列：已启用 / 已禁用 / 出错（带原因）/ 不兼容 |

### 常见错误速查

| 现象 | 原因 / 处理 |
| --- | --- |
| 未找到插件清单横幅 | 手工上传的文件必须以 `/*!lxplugin` 开头（用构建脚本生成） |
| 插件清单 version 格式非法 | 版本要形如 `1.0.0` |
| main 必须是不含路径分隔符的 .js/.cjs 文件名 | 清单里别写 `./index.js` 或子目录 |
| 插件已安装（id），请使用“更新”功能 | 同 id 目录已存在；先卸载，或用「上传新版本」 |
| 新版本低于已安装版本 | 仅拒绝降级；同版本现已允许覆盖更新（见 [9.2](#92-已知缺陷--坑) ②，更新保留 config） |
| 状态「出错」+ 原因 | 通常是 `setup()` 抛错或入口有语法错误；按原因定位 |
| 状态「不兼容」 | `engines.app` 与当前客户端版本不符 |
| `require("x") 不支持` | main 端 `createRequire(入口)` 只能加载插件目录内文件 + node 内置模块；renderer 端需要主窗口的 `window.require` |
| 改了 renderer 插件代码没生效 | 见 [9.2](#92-已知缺陷--坑)：renderer 插件更新不热替换，需**禁用→启用**或重启 |

---

## 9. 限制与已知缺陷

### 9.1 设计上的限制

| 限制 | 说明 |
| --- | --- |
| **无沙箱** | 插件是用户显式安装并启用的可执行代码，等价于直接运行脚本。宿主只保证「安装/解析清单阶段**不执行**插件代码」 |
| 钩子不跨进程 | main 与 renderer 各自一条总线，`emit` 不会跨进程 |
| renderer 端 `api.dir` 为空 | 渲染端拿不到插件目录路径，需要落盘请走 `getConfig/setConfig`、`getData/setData`（或经 IPC） |
| 单文件体积上限 | 8 MB（上传与读写入口文件都有校验） |
| 下载任务不走插件代理 | 下载有独立 agent 构造（`src/common/utils/download/util.ts`，运行在 download worker 中、拿不到 `window.lx`） |
| 音乐源只参与跨源搜索 | 见 [5.8](#58-apiregistermusicsource--注册音乐源仅-renderer) |
| `engines.app` 只支持单约束 | 不能写 `>=2 && <3` |
| 版本比较忽略预发布号 | `1.2.3-beta.1` 与 `1.2.3` 比较结果相等 |

### 9.2 已知缺陷 / 坑

| # | 问题 | 规避方式 |
| --- | --- | --- |
| ① | **renderer 端插件更新不热替换**：`loadRendererPlugin()` 对已加载的 id 直接早退；且 `onUpdate` 只在 main 端被调用 | 更新后**禁用 → 启用**（会先 unload 再 load），或重启客户端 |
| ② | （已修复）~~同版本插件无法「上传更新」~~：`src/plugins/manager.ts` 的 `applyUpdate`/`update` 已放宽为「仅拒绝降级（新版本 < 旧版本）」，同版本可覆盖更新；更新经 `withPreservedFiles` 保留 `config.json`/`data.json`，不丢配置 | 仍受 ① 影响：renderer 插件更新后需**禁用 → 启用**或重启才会生效 |
| ③ | `api.unpatch(target, method)` **不传 `wrapper`** 时会移除该方法上的**全部**包装（含其它插件的），并使本插件其它 patch 失去追踪（卸载不回退） | **总是传 `wrapper`**：`api.unpatch(target, method, wrapper)` |
| ④ | patch 对「已被提前取走引用的函数」无效 | 换切入点，或包装其调用方 |
| ⑤ | 宿主无内置 `intercept` 拦截点 | 用 `api.patch`；需要协作点时可自行约定事件名 |
| ⑥ | renderer 端 `getData/setData` 用 `localStorage`，**卸载不清理** | 需要清理就在 `uninstall()` 里显式覆盖 |

> ①②③ 中 ② 已修复（`manager.ts` 版本门槛放宽为允许同版本覆盖更新，保留 config）；①③ 仍需手动规避。修这些缺陷会动到 `src/plugins/{renderer,manager,host}.ts`，改动后请同步更新本节与本文件的相关说明。

---

## 10. 文档同步约定

**规则：只要 `src/plugins/**` 的能力面发生变化（新增/修改 API、清单字段、生命周期回调、设置面板字段类型、存储位置、状态语义、限制修复），必须在同一次改动里同步更新本目录文档。**

### 10.1 文档地图：改什么 → 改哪里

| 框架变化 | 必须更新 |
| --- | --- |
| 新增/修改插件 API、字段、回调 | 本文件 [第 5 节](#5-插件-api-参考)、[第 4 节](#4-入口模块与生命周期) 的表格；`src/plugins/types.ts` 的注释 |
| 新增设置面板字段类型 / 面板行为 | 本文件 [5.7](#57-apiregistersettings--声明式设置面板仅-renderer)；`ui/PluginSettingsPanel.vue` |
| 新增宿主事件 / 拦截点 | 本文件 [5.3](#53-apihooks--事件与拦截) 的内置事件表 |
| 清单新增字段 / 校验规则变化 | 本文件 [第 3 节](#3-清单-pluginjson)；`validate.ts`、构建脚本 `normalizeManifest` |
| 构建 / 发布 / CI 流程变化 | [`lx-plugins/README.md`](./README.md) 的「构建」「CI 与发布」 |
| 目录结构、新增插件项目 | [`lx-plugins/README.md`](./README.md) 的「目录结构」「插件清单」 |
| 单个插件的功能 / 配置项变化 | 该插件自己的 `lx-plugins/<项目>/README.md` |
| 上游侵入点增减（`=== Plugin Manager ===`） | [`lx-plugins/README.md`](./README.md) 的「与上游代码的合并关系」、`src/plugins/types.ts` |
| 修掉某个已知缺陷 | 本文件 [9.2](#92-已知缺陷--坑)（删掉该行）、[第 8 节](#8-本地开发与调试)的速查表 |
| 新增插件系统能力条目 | 本文件 [附录 A](#附录-a框架能力变更记录) 追加一行 |

### 10.2 改动自检清单

改完文档跑一遍（**前三条可直接复制执行**）：

```bash
# 1) 文档里的相对链接与页内锚点是否都还有效（0 失效才通过，脚本零依赖）
node lx-plugins/tools/check-doc-links.js lx-plugins README.md

# 2) 路径描述是否还正确（应只剩「插件管理（侧边栏）」这种新写法）
grep -rn "插件管理（侧边栏）\|设置 → 插件管理" lx-plugins src --include='*.md' --include='*.js' --include='*.ts' --include='*.vue'

# 3) 上游侵入点数量是否与文档一致
grep -rnF '=== Plugin Manager ===' src
```

- [ ] 上面三条自检全部通过
- [ ] 本文件的能力矩阵（[5.2](#52-能力矩阵哪些能力在哪端可用)）与 `src/plugins/host.ts` / `renderer.ts` 是否一致
- [ ] 附录 A 是否补记了本次能力变化
- [ ] `lx-plugins/*/README.md` 中受影响插件的说明是否已更新

> `lx-plugins/tools/check-doc-links.js` 的锚点算法已对齐 GitHub（**每个空格转一个连字符、不折叠**，点号/全角括号等标点整类删除）。
> 所以标题与锚点的对应关系长这样，写锚点时照这个规则拼，别按「折叠空格」的直觉猜：
>
> ```text
> ### 5.4 `api.patch` —— 运行时覆盖原功能
>                     ↓
> #54-apipatch--运行时覆盖原功能
> ```

---

## 附录 A：框架能力变更记录

> 新增/变更框架能力时在**最上面**追加一行（最新的在上）。

| 时间 | 变化 | 关联提交 |
| --- | --- | --- |
| 2026-09-18 | 新增主进程插件能力 `api.electron` / `api.setTouchBar` / `api.controlPlayer`（Touch Bar 与播放控制），配套 `src/plugins/winBridge.ts` 注册式桥；新增 `lx-plugins/touch_bar` 插件 | 本次改动 |
| 2026-09-15 | 构建产物名改为带版本号（`<插件名>-<版本>.lxplugin`）；构建前自动清理该项目在输出目录里的旧产物；CI 改用 `dist/*.lxplugin` 通配收集，快速通道先把非本版本的插件附件删掉 | 本次改动 |
| 2026-09-15 | 插件管理入口从「设置 → 插件管理」标签页迁到**侧边栏独立页** `/plugins`（`ui/Plugins.vue` + `#icon-plugin`）；设置里不再有该标签页 | `cdb2f13d` |
| 2026-09-15 | 备份/同步相关配置文档细化（远端目录、文件名、超时） | `e138efb5` |
| — | `listData` 收藏数据桥逻辑优化（`Promise.all` 并发、可选链） | `be7f11df` `ee72b328` `9263acf8` |
| — | 新增 `sync-favorites` 插件（WebDAV / FTP / SMB 收藏同步），并因此扩展收藏数据桥 | `fc58f5ff` |
| — | 构建流程：插件**目录变更快速通道**、插件版本自动跟随 app 版本、设置面板按钮组（`buttons`） | `33e07aee` |
| — | SOCKS5 支持 **Chromium 会话代理接管**（`api.setSessionProxy`），使播放/封面也走代理 | `2c8e4a64` |
| — | 设置面板输入字段实时草稿 + 提交逻辑修复（输入不再被轮询回滚） | `5b205096` `b201af60` `3a7ab251` |
| — | 新增插件配置管理（`config.json` + `getConfig/setConfig` + `registerSettings`） | `f41f7f07` |
| — | renderer 端插件加载状态上报（修「renderer 插件恒显示已禁用」） | `54c0d4d4` |
| — | 单文件 `.lxplugin` 格式、构建脚本与工作流优化 | `0405c6aa` `7add5168` |
| — | 插件系统初版（宿主 / 管理器 / 加载器 / 热加载），内置 `sock_proxy`、`forbidden_update` | `4d96f603` `b57474f4` |

---

## 附录 B：与上游代码的合并关系

插件系统对上游源码的侵入点全部带 `=== Plugin Manager ===` 标记，一条命令可全部定位：

```bash
grep -rnF '=== Plugin Manager ===' src
```

细节表格见 [`lx-plugins/README.md`](./README.md#与上游代码的合并关系)。同步上游后只要保证这些标记仍在、`src/plugins/` 目录整体带入即可。
