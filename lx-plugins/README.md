# lx-plugins

lx-music-desktop 的**统一插件项目目录**。所有自研插件都以「一个子目录 = 一个插件项目」的形式放在这里，
每个项目构建出的产物都是**单个文件**（`.lxplugin`），可直接在客户端的「设置 → 插件管理」里上传安装 / 更新。

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
2. 放入 `plugin.json`：

   ```json
   {
     "id": "my-plugin",
     "name": "my-plugin",
     "version": "1.0.0",
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
| 日志 | `api.logger.info/warn/error` | 统一带 `[plugin:<id>]` 前缀 |

## 与上游代码的合并关系

插件系统对上游源码只有 **5 处**带 `Plugin Manager` 标记的极小改动：

| 文件 | 改动 |
| --- | --- |
| `src/main/index.ts` | 初始化插件管理（加载主进程插件、注册管理 IPC） |
| `src/renderer/main.ts` | 初始化渲染端插件宿主 |
| `src/renderer/utils/musicSdk/index.js` | 调用时合并插件注册的音乐源 |
| `src/renderer/utils/request.js` | `getRequestAgent` 中查询 `window.lx.pluginNetAgent`，允许插件接管代理 agent |
| `src/renderer/views/Setting/index.vue` | 新增「插件管理」标签页 |

其余全部是本目录与 `src/plugins/` 下的**新增文件**，合入上游更新时不会冲突：
同步上游后只需保证上述 5 处标记仍在即可。这 5 处使用**完全一致的标记文本**，一条命令即可全部定位：

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
| `.github/workflows/plugin-build.yml` | `lx-plugins/**`、`src/plugins/**` 变更（push / PR）、手动触发 | 只构建插件，产物上传为 Actions Artifact（轻量，零依赖，用于快速反馈） |
| `.github/workflows/beta-pack.yml` | 推送 `beta` 分支 | 构建各平台安装包 **+ 插件**，全部成功后在 `Release` 任务里**自动创建 GitHub Pre-release**，把安装包与 `.lxplugin` 一起上传为预发布附件 |

Pre-release 的命名规则：

- **tag**：`v<package.json 版本>-beta.<工作流运行号>`，例如 `v2.12.5-beta.42`
- **标题**：`Beta v2.12.5 (build 42)`
- 标记为 **Pre-release**（`prerelease: true`，`draft: false`），因此不会占用「Latest」位置
- 预发布正文会附带自动生成的更新说明（`generate_release_notes`）

> 插件构建脚本零依赖，所以 `Plugins` 任务只做 `checkout` + `node` + 跑脚本，不执行 `npm ci`。
