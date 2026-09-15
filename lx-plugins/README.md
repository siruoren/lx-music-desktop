# lx-plugins

lx-music-desktop 的**统一插件项目目录**。所有自研插件都以「一个子目录 = 一个插件项目」的形式放在这里，
每个项目构建出的产物都是**单个文件**（`.lxplugin`），可直接在客户端侧边栏的「插件管理」里上传安装 / 更新。

> 插件**运行时**（宿主、管理器、加载器、管理界面、函数包装器等）位于 [`src/plugins`](../src/plugins)，
> 会随主程序一起打包。本目录只是插件**源码与构建**目录，不参与主程序打包。

## 文档地图

| 文档 | 内容 |
| --- | --- |
| [`DEVELOPMENT.md`](./DEVELOPMENT.md) | **插件开发指南（框架能力的权威参考）**：清单字段、生命周期、API 语义、设置面板字段、存储、宿主扩展点、常见配方、调试、限制与已知缺陷 |
| 本文件 `README.md` | 目录索引：这里有哪些插件、怎么构建、怎么发布（CI / Pre-release）、与上游的合并关系 |
| [`<插件项目>/README.md`](./sync-favorites/README.md) | 单个插件自己的说明（功能、配置项、实现要点） |

> 改完插件系统后**必须同步更新文档**，规则与自检清单见 [DEVELOPMENT.md 第 10 节](./DEVELOPMENT.md#10-文档同步约定) 与本文件
> [「文档同步约定」](#文档同步约定)。

## 目录结构

```
lx-plugins/
├── README.md                     本文件（索引）
├── DEVELOPMENT.md                插件开发指南（框架能力参考）
├── repo-source-plugins/          音乐源增强（远程自定义源批量导入 + 同源去重）
├── sock_proxy/                   SOCKS5 代理（含 Chromium 会话层，让播放也走代理）
├── forbidden_update/             禁用客户端「检查更新」
├── sync-favorites/               我的列表同步（WebDAV / FTP / SMB）
└── <任意插件项目>/               一个子目录 = 一个插件项目（目录名 = 插件 id / 名称 / 产物名）
    ├── plugin.json               插件清单
    ├── index.js                  插件入口（CommonJS）
    ├── build.js                  零依赖构建脚本（可复用/复制）
    ├── README.md                 该插件的说明
    └── dist/                     构建产物（.gitignore 已忽略 dist）
        └── <项目名>.lxplugin
```

## 插件清单

| 插件 | 作用 | 端 | 文档 / 源码 |
| --- | --- | --- | --- |
| `repo-source-plugins` | 远程自定义源批量导入与自动更新；搜索结果同源去重（可开关） | renderer | [README](./repo-source-plugins/README.md) |
| `sock_proxy` | 为客户端提供 SOCKS5 代理，同时接管 Node 请求层与 Chromium 会话层 | main + renderer | [index.js](./sock_proxy/index.js)（详见[「代理为什么有两层」](#代理为什么有两层重要)） |
| `forbidden_update` | 禁用「检查更新」：不发起检查、也不接收更新事件 | renderer | [index.js](./forbidden_update/index.js) |
| `sync-favorites` | 我的列表 / 收藏同步到 WebDAV / FTP / SMB，支持定时、加密、还原 | renderer | [README](./sync-favorites/README.md) |

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
安装进客户端后，插件目录为 `userData/plugins/<id>/`（`plugin.json` + 入口文件 + `config.json` / `data.json`）。

> ⚠️ `npm run build:plugin` 带 `--all`，**不能**再跟项目名；只构建某一个项目请直接调 `build.js <项目名>`。

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
     setup(api) {},        // api.patch / api.hooks / api.registerMusicSource / api.getData / api.setData / api.registerSettings …
     uninstall() {},
     onUpdate(oldVersion) {},
     onConfigChange(config) {},
     onSettingsAction(action, config) {},
   }
   ```

4. 复用构建脚本，或直接复制 `repo-source-plugins/build.js` 到新项目（脚本会自动以所在目录为项目）。
5. `node lx-plugins/repo-source-plugins/build.js my-plugin`（或在项目内运行 `build.js`），得到单个 `.lxplugin` 文件。

> 字段含义、校验规则、API 语义、设置面板写法、调试技巧，全部见 [`DEVELOPMENT.md`](./DEVELOPMENT.md)。
> 开发期可跳过构建，用插件管理页的「安装插件目录（本地开发）」直接选插件目录。

## 插件能做什么（速查）

| 能力 | 一句话 | 详见 |
| --- | --- | --- |
| 覆盖 / 修改原功能 | `api.patch(target, 'method', (next, ...args) => …)`，运行时包装原函数，禁用/卸载自动还原，**源码零改动** | [指南 5.4](./DEVELOPMENT.md#54-apipatch--运行时覆盖原功能) |
| 生命周期事件 | `api.hooks.on('app:ready', fn)`；内置事件只有 `app:ready` / `plugin:loaded` / `plugin:unloaded` | [指南 5.3](./DEVELOPMENT.md#53-apihooks--事件与拦截) |
| 拦截 / 改写数据流 | `api.hooks.intercept(name, (ctx, next) => next(ctx))` 责任链，可改写 `ctx` 或直接短路；**宿主暂无内置拦截点** | [指南 5.3](./DEVELOPMENT.md#53-apihooks--事件与拦截) |
| 注册音乐源 | `api.registerMusicSource(id, name, module)`，注册后参与跨源搜索，卸载自动移除 | [指南 5.8](./DEVELOPMENT.md#58-apiregistermusicsource--注册音乐源仅-renderer) |
| 私有持久化 | `api.getData(key, def)` / `api.setData(key, value)`：main 端 `userData/plugins/<id>/data.json`，renderer 端 localStorage | [指南 5.5](./DEVELOPMENT.md#55-apigetdata--apisetdata--私有键值存储) |
| 插件配置（设置面板） | `api.getConfig()` / `api.setConfig(patch)` / `api.registerSettings(spec)`，配置存 `<插件目录>/config.json`，与 `data.json` 分开；面板由宿主渲染，插件无需自带 Vue 组件 | [指南 5.7](./DEVELOPMENT.md#57-apiregistersettings--声明式设置面板仅-renderer) |
| 接管 Chromium 会话代理 | `api.setSessionProxy(rules \| null)`（**仅 main 端**）：让 `<audio>`/`<img>` 等 Chromium 直接发起的请求（**音乐播放**、封面）也走代理 | [下节](#代理为什么有两层重要) |
| 接管 Node 请求代理 | `window.lx.pluginNetAgent = (url, proxyOptions) => agent \| undefined`（renderer 端），接管音乐源 API 请求所用的 http.Agent | [下节](#代理为什么有两层重要) |
| 收藏数据桥 | `window.lx.plugins.listData.exportAll(scope?)` / `importAll(lists, scope?)` | [指南 7.4](./DEVELOPMENT.md#74-读写我的列表收藏) |
| 日志 | `api.logger.info/warn/error`，统一带 `[plugin:<id>]` 前缀 | [指南 5.1](./DEVELOPMENT.md#51-通用成员) |

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

## 文档同步约定

**插件系统的能力面发生变化时，必须在同一次改动里同步更新文档。** 权威文档是
[`DEVELOPMENT.md`](./DEVELOPMENT.md)，本文件负责索引与发布流程。

| 框架变化 | 改哪里 |
| --- | --- |
| 新增/修改 API、清单字段、生命周期回调、设置面板字段 | [`DEVELOPMENT.md`](./DEVELOPMENT.md)（第 3 / 4 / 5 节）+ `src/plugins/types.ts` 注释 |
| 新增宿主事件 / 拦截点 | [`DEVELOPMENT.md`](./DEVELOPMENT.md) 5.3 的内置事件表 |
| 构建 / 发布 / CI 流程变化 | 本文件「构建」「CI 与发布」 |
| 新增插件项目 | 本文件「目录结构」「插件清单」 |
| 单个插件的功能 / 配置项变化 | 该插件自己的 `<插件项目>/README.md` |
| 上游侵入点增减 | 本文件「与上游代码的合并关系」+ `src/plugins/types.ts` |
| 修复已知缺陷 | [`DEVELOPMENT.md`](./DEVELOPMENT.md) 第 9.2 节（删行）与第 8 节速查表 |
| 任何能力变化 | [`DEVELOPMENT.md`](./DEVELOPMENT.md) 附录 A「框架能力变更记录」追加一行 |

改完自查：

```bash
grep -rnF '=== Plugin Manager ===' src                                    # 侵入点是否与文档一致
grep -rn "插件管理（侧边栏）" lx-plugins src --include='*.md' --include='*.js' --include='*.ts' --include='*.vue'
```
