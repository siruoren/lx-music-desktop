# lx-plugins

lx-music-desktop 的**统一插件项目目录**。所有自研插件都以「一个子目录 = 一个插件项目」的形式放在这里，
每个项目构建出的产物都是**单个文件**（`.lxplugin`），可直接在客户端侧边栏的「插件管理」里上传安装 / 更新。

> 插件**运行时**（宿主、管理器、加载器、管理界面、函数包装器等）位于 [`src/plugins`](../src/plugins)，
> 会随主程序一起打包。本目录只是插件**源码与构建**目录，不参与主程序打包。

## 目录结构

```
lx-plugins/
├── README.md                     本文件
├── repo-source-plugins/          音乐源增强（跨源去重 + 统计 + 注册自定义音乐源）
├── sock_proxy/                   让「设置 → 网络代理」支持 SOCKS5
├── forbidden_update/             禁用客户端「检查更新」
└── <任意插件项目>/               一个子目录 = 一个插件项目（目录名 = 插件 id / 名称）
    ├── plugin.json               插件清单
    ├── index.js                  插件入口（CommonJS）
    ├── build.js                  零依赖构建脚本
    ├── README.md                 该插件的说明
    └── dist/                     构建产物（.gitignore 已忽略 dist）
        └── <项目名>.lxplugin
```

## 构建

构建脚本零依赖，**不需要 `npm install`**：

```bash
npm run build:plugin                                   # 构建 lx-plugins 下全部插件项目
node lx-plugins/repo-source-plugins/build.js           # 只构建脚本所在的项目
node lx-plugins/repo-source-plugins/build.js <项目名>   # 构建指定项目
node lx-plugins/repo-source-plugins/build.js --all      # 构建全部项目
node lx-plugins/repo-source-plugins/build.js --all --out /tmp/out   # 指定输出目录
```

产物文件名取自**插件项目目录名**，即 `lx-plugins/<项目目录名>/dist/<项目目录名>.lxplugin`。
安装进客户端后，插件目录为 `userData/plugins/<id>/`（`plugin.json` + 入口文件）。

## 新增一个插件项目

1. 在 `lx-plugins/` 下新建目录，目录名即插件名，例如 `lx-plugins/my-plugin/`。
2. 放入 `plugin.json`（**不需要写 version**：构建时自动注入仓库根 `package.json` 的 app 版本，
   所有插件版本自动与 app 保持一致；写了也会被忽略）：

   ```json
   {
     "id": "my-plugin",
     "name": "my-plugin",
     "description": "插件说明",
     "main": "index.js",
     "platforms": ["renderer"]
   }
   ```

3. 放入入口 `index.js`（CommonJS）：

   ```js
   module.exports = {
     setup(api) {
       // api.patch / api.hooks / api.registerMusicSource / api.getData / api.setData
     },
     uninstall() {},
     onUpdate(oldVersion) {},
   }
   ```

4. 复用构建脚本，或直接复制 `repo-source-plugins/build.js` 到新项目（脚本会自动以所在目录为项目）。
5. `npm run build:plugin`（或在项目内运行 `build.js`），得到单个 `.lxplugin` 文件。

## 插件能力一览

| 能力 | 用法 | 说明 |
| --- | --- | --- |
| 覆盖 / 修改原功能 | `api.patch(target, 'method', (next, ...args) => ...)` | 运行时包装原函数；不调用 `next` 即完全覆盖，调用即前后增强。禁用/卸载时自动还原，**源码零改动** |
| 生命周期事件 | `api.hooks.on('app:ready', fn)` | 事件监听；`api.hooks.emit` 发射 |
| 拦截 / 改写数据流 | `api.hooks.intercept('name', (ctx, next) => next(ctx))` | 责任链，可改写 `ctx` 或直接短路 |
| 注册音乐源 | `api.registerMusicSource(id, name, module)` | 注册后参与 `musicSdk.init()` 与跨源搜索，卸载自动移除 |
| 私有持久化 | `api.getData(key, def)` / `api.setData(key, value)` | main 端存 `userData/plugins/<id>/data.json`，renderer 端存 localStorage |
| 插件配置（设置面板） | `api.getConfig()` / `api.setConfig(patch)` / `api.registerSettings(spec)` | 配置存 `<插件目录>/config.json`，与 `data.json` 分开；面板由宿主渲染，插件无需自带 Vue 组件 |
| 接管 Chromium 会话代理 | `api.setSessionProxy(rules \| null)`（**仅 main 端**） | 把 Electron `proxyRules` 设到 BrowserWindow 的 Chromium 会话上，使 `<audio>`/`<img>` 等由 Chromium 直接发起的请求（**音乐播放**、封面）也走代理；传 `null` 撤销、回到 app 自身的网络代理。详见下节 |
| 接管 Node 请求代理 | `window.lx.pluginNetAgent = (url, proxyOptions) => agent \| undefined`（renderer 端） | 接管各音乐源 API 请求（搜索/歌单/歌词…）所用的 http.Agent |
| 日志 | `api.logger.info/warn/error` | 统一带 `[plugin:<id>]` 前缀 |

## 代理为什么有两层（重要）

`<audio>` 播放与封面加载**不经过** `src/renderer/utils/request.js`：它们是 Chromium 自己发起的请求，
走的是 BrowserWindow 的 **Chromium 会话**。因此只接管 Node 的 http.Agent 会出现
「设置面板里测试连接通过、接口也走了代理，但**播放依然直连**」的现象。

要让播放也走代理，必须两层都覆盖：

| 层 | 覆盖范围 | 接管方式 | 代码位置 |
| --- | --- | --- | --- |
| Node 请求层 | 音乐源 API：搜索 / 歌单 / 歌词 / 评论 / 榜单 / 热词 | `window.lx.pluginNetAgent` | `src/renderer/utils/request.js` |
| Chromium 会话层 | **音乐播放**（`<audio>`）、封面（`<img>`） | `api.setSessionProxy(rules)` | `src/plugins/sessionProxy.ts` + `src/main/modules/winMain/main.ts` |

规则优先级：**插件声明 > app 自身的网络代理 > 直连**（`resolveSessionProxyRules`），
并且 app 改网络设置或重建窗口后插件声明依然生效。

> ⚠️ `sock_proxy` 因此声明为 `"platforms": ["main", "renderer"]`：renderer 端接管 Node 请求，
> main 端接管会话代理。**只声明 renderer 端时播放不会走代理**。
>
> 另注：`sock_proxy` 在 main 端起一个只监听 `127.0.0.1` 的本地 HTTP 桥，会话层**一律**
> 经它转发（不直接用 Chromium 原生 `socks5://`），原因有二：
>  1. Chromium 对 SOCKS5 代理会在**本地解析 DNS**（远程 DNS 不生效），本地解析不了/被污染
>     的域名播放就会失败 —— HTTP 桥的 CONNECT 会把域名原样交给代理解析，正好绕开；
>  2. Chromium 不支持带用户名/密码的 SOCKS5（URL 里的凭据会被静默忽略），认证统一在桥里
>     完成（RFC1929）。
>
> 未覆盖：下载任务有独立的 agent 构造（`src/common/utils/download/util.ts`，运行在 download
> worker 中、拿不到 `window.lx`）。

## 与上游代码的合并关系

插件系统对上游源码只有 **6 处**带 `Plugin Manager` 标记的极小改动（插件管理 UI 入口涉及 3 个文件，故实际改动文件为 8 个）：

| 文件 | 改动 |
| --- | --- |
| `src/main/index.ts` | 初始化插件管理（加载主进程插件、注册管理 IPC） |
| `src/renderer/main.ts` | 初始化渲染端插件宿主 |
| `src/renderer/utils/musicSdk/index.js` | 调用时合并插件注册的音乐源 |
| `src/renderer/utils/request.js` | `getRequestAgent` 中查询 `window.lx.pluginNetAgent`，允许插件接管代理 agent |
| `src/main/modules/winMain/main.ts` | 应用会话代理前先问插件系统（`resolveSessionProxyRules`），使插件接管能作用于「播放」 |
| `src/renderer/router.ts`<br>`components/layout/Aside/NavBar.vue`<br>`components/layout/Icons.vue` | 插件管理 UI 入口：`/plugins` 路由、侧边栏菜单项（在「设置」下方）与 `#icon-plugin` 图标 |

其余全部是本目录与 `src/plugins/` 下的**新增文件**，合入上游更新时不会冲突：
同步上游后只需保证上述标记仍在即可。这些改动使用**完全一致的标记文本**，一条命令即可全部定位：

```bash
grep -rnF '=== Plugin Manager ===' src
```

## 插件状态说明

插件管理页的状态列直接来自主进程的 `PluginManager.list()`：

| 状态 | 含义 |
| --- | --- |
| 已启用 | 启用开关为开，且无加载失败记录 |
| 已禁用 | 启用开关为关（插件安装后默认启用） |
| 出错 | 已启用且版本兼容，但加载/执行失败，右侧会显示具体原因 |
| 不兼容 | 已启用，但 `engines.app` 与当前客户端版本不符 |

> 主进程只加载 `main` 端插件，**判断不了 renderer 端插件是否真的加载成功**，
> 因此 renderer 宿主加载后会通过 `plugin:reportState` 把结果回传给主进程（成功 / 失败+原因 / 已卸载）。
> 若不做这个回传，renderer 端插件就会恒显示为「已禁用」。

## CI 与发布

| 工作流 | 触发 | 作用 |
| --- | --- | --- |
| `.github/workflows/plugin-build.yml` | `lx-plugins/**`、`src/plugins/**` 变更（push / PR）、手动触发 | 只构建插件，**每个插件单独构建、单独上传为一个 Actions Artifact**（名为 `lx-plugin-<插件名>`，可只下载某一个插件；轻量，零依赖，用于快速反馈） |
| `.github/workflows/beta-pack.yml` | 推送 `beta` 分支 | 构建各平台安装包 **+ 插件**，全部成功后在 `Release` 任务里**自动创建 GitHub Pre-release**，把安装包与 `.lxplugin` **逐个上传为相互独立的附件** |

插件在发布链路里的处理方式：

- **插件列表自动发现**：`PluginMeta` 任务扫描 `lx-plugins/*/plugin.json` 得到插件清单，供矩阵构建与发布说明使用；新增插件项目**不需要改任何工作流文件**。
- **一个插件一个构建任务**：`Plugins` 矩阵按插件并行构建，每个插件产出自己名下的 Artifact（`lx-plugin-<插件名>`），其中一个插件构建失败不影响其它插件（`fail-fast: false`）。
- **每个插件都是独立附件**：`Release` 任务下载产物时不再合并成一个目录（`merge-multiple: false`），上传规则按前缀区分，因此**每个插件在 Pre-release 里都是单独一个 `.lxplugin` 附件**，可单独下载某一个插件；安装包同理各自独立。
- **插件不做独立 Release**：插件统一随 app 的 Pre-release 发布，不为插件单独建 Release/tag。
- **插件版本自动与 app 版本保持一致**：构建脚本从仓库根 `package.json` 读取 app 版本并注入产物清单
  （`plugin.json` 无需也无法单独指定版本）。因此发新版插件 = 改完插件代码后推 `beta` 分支即可，
  附件会带上与 app 一致的版本号。
- **仅插件变更走快速通道**：`Changes` 任务判断本次推送的变更范围 —— 若只动了 `lx-plugins/**`
  或 `.github/workflows/plugin-build.yml`，各平台安装包任务全部跳过，只跑插件矩阵，并把新构建的
  `.lxplugin` 用 `gh release upload --clobber` **覆盖到最新 Pre-release 的附件**（没有 Pre-release
  时回退为新建一个）；插件本身有变化、需要客户端行为配合时仍推完整安装包流程。

Pre-release 的命名规则：

- **tag**：`v<package.json 版本>-beta.<工作流运行号>`，例如 `v2.12.5-beta.42`
- **标题**：`Beta v2.12.5 (build 42)`
- 标记为 **Pre-release**（`prerelease: true`，`draft: false`），因此不会占用「Latest」位置
- 预发布正文会附带自动生成的更新说明（`generate_release_notes`），并单列一节「插件（每个插件单独一个附件）」，逐行给出插件名、版本（自动等于 app 版本）与说明

> 插件构建脚本零依赖，所以 `Plugins` 任务只做 `checkout` + `node` + 跑脚本，不执行 `npm ci`。

## sync-favorites（我的列表同步）

把客户端的「我的列表」（试听列表 / 我的收藏 / 用户自建歌单及其歌曲）同步到远端，支持 **WebDAV** 与 **FTP** 两种协议，可定时执行，并支持「从远端还原」。**同步范围可选**：可只同步「我的收藏」、只同步「我的列表（歌单）」，或排除临时的「试听列表」。

> lx-music-desktop 自带「设置 → 数据同步」（仅连官方 sync-server）与「设置 → 备份」（本机导出），
> **原生不支持 WebDAV / FTP**。本插件补上这条最通用的同步通道，可与群晖 Drive、Nextcloud、坚果云、
> 自建 FTP 等任意支持 WebDAV / FTP 的服务搭配。

### 配置项（插件管理 → 我的列表同步 → 设置）

| 配置 | 说明 |
| --- | --- |
| 同步协议 `type` | `webdav`（默认）或 `ftp` |
| 服务器地址 `host` | WebDAV 含协议，如 `https://dav.example.com`；FTP 仅主机名 |
| 端口 `port` | 留空用默认（WebDAV 依协议；FTP 默认 21） |
| 远端目录 `remotePath` | 备份文件所在目录，默认 `lx-music/favorites`（不含文件名，上传时会自动逐级创建） |
| 文件名 `filename` | 备份文件名，默认 `lx_favorites.json` |
| 账号 / 密码 | 留空表示匿名 / 无认证 |
| 忽略证书校验 `insecure` | WebDAV 自签名证书时开启 |
| 启用 FTPS `secure` | FTP 走 `AUTH TLS` 显式加密（控制 + 数据连接均加密） |
| 被动模式 `passive` | FTP 默认开；连不上再尝试关 |
| 超时 `timeout` | 单次网络请求超时（毫秒），默认 `20000` |
| 同步方向 `mode` | `upload`=备份到远端；`download`=从远端还原到本地；`both`=双向合并（推荐）。双向/还原时若本地与远端都有改动，按「冲突策略」处理；内容无变化则跳过传输（增量） |
| 冲突策略 `conflictStrategy` | 本地与远端都改了同一列表时如何处理：`merge`=合并双方（并集，不丢歌）；`local`=以本地为准覆盖远端；`remote`=以远端为准覆盖本地 |
| 同步范围 `scope` | 逗号分隔，控制同步哪些列表：`default`=试听列表、`love`=我的收藏、`user`=我的列表（创建的歌单）；留空或 `all`=全部同步（默认 `default,love,user`）。**试听列表是临时播放队列，跨设备同步通常意义不大，可去掉 `default` 只写 `love,user`**。范围只影响选中类别，未选中的列表在还原/双向时保持本地原样、不会被清空 |
| 启用定时同步 / 间隔 | 开启后每 `间隔` 分钟在后台自动同步一次 |
| 加密 `encrypt` + 加密密码 | 备份文件用 AES-256-CBC 加密，即使服务端泄露也读不到收藏；还原需填相同密码 |

面板按钮：**立即备份** / **立即还原** / **测试连接**（在目标目录放一个临时文件并回读，验证读写权限）。面板底部「状态」实时显示上次执行结果与时间（成功/失败 + 解决冲突列表数 + 是否跳过无变化传输）。

### 实现要点

- **网络层零依赖**：WebDAV 走 Node 内置 `http/https`（PUT/GET/MKCOL/DELETE + Basic Auth），
  FTP 走 `net/tls` 自实现 PASV 流程（STOR/RETR/LIST/MKD/CWD/DELE，可选 FTPS）。因此产物仍是单文件 `.lxplugin`，不需要任何 `node_modules`。
- **收藏数据桥**：渲染端收藏存于 SQLite（`lx.data.db`），读写必须走 store action。插件系统在
  `src/plugins/renderer.ts` 新增 `listDataBridge` 并挂到 `window.lx.plugins.listData`，
  暴露 `exportAll(scope?)`（按范围读列表 + 歌曲）与 `importAll(lists, scope?)`（按 id 覆盖/新增写回）。
  `scope` 支持 `default`/`love`/`user` 三类过滤；`importAll` 会读回未选中类别的当前内容并回填，
  因此还原/双向同步**不会误清空**未勾选的列表（如只同步歌单时，本地的收藏与试听列表保持原样）。
- **备份格式**：一个 JSON 信封（`_type: favorites`，含 `_createdAt`；开启加密时 `lists` 改为 AES 密文），
  与「设置 → 备份」导出的结构无关，是插件自有的、可跨设备还原的纯文本（或密文）文件。
- **定时**：`setInterval` 后台执行，卸载 / 关闭定时时清理，避免泄漏。
- **增量同步 + 冲突合并**：每次同步都以「上次同步基线」（`api.setData('syncBase')` 持久化的、各列表的歌曲 id 集合，即三路合并的共同祖先）做比对：
  - 仅一侧有改动 → 自动取那一側，**不冲突**；
  - 两侧都改了同一列表 → **冲突**，按 `conflictStrategy` 处理：`merge` 取并集（不丢歌）、`local`/`remote` 以某侧覆盖；
  - 合并结果若与远端 / 本地现状**完全一致**，则**跳过传输 / 写回**（增量：不重复覆盖、不浪费请求）。
  - 基线在每次同步成功后更新，作为下一次的共同祖先；换设备首次同步（无基线）默认走 `merge`（并集，安全不丢数据）。

### 注意事项

- 「立即还原」/`both` 不再是无脑覆盖：冲突列表按「冲突策略」合并或覆盖，非冲突列表自动按各自改动合并，**不会无谓丢失一侧的收藏**。仍有风险（如策略选 `local`/`remote` 时，被覆盖一侧的该列表改动会丢失），故还原/双向前建议先「立即备份」一份本地数据。
- 同版本插件无法走「上传更新」覆盖安装（app 版插件管理要求新版本 > 旧版本，详见 MEMORY），
  改完代码后需推 `beta` 分支让版本号随 app 递增，或卸载重装。
