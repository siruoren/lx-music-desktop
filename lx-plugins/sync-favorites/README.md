# sync-favorites（我的列表同步）

把客户端的「我的列表」（试听列表 / 我的收藏 / 用户自建歌单及其歌曲）同步到远端，支持 **WebDAV** / **FTP** / **SMB** 三种协议，可定时执行，并支持「从远端还原」。**同步范围可选**：可只同步「我的收藏」、只同步「我的列表（歌单）」，或排除临时的「试听列表」。

> lx-music-desktop 自带「设置 → 数据同步」（仅连官方 sync-server）与「设置 → 备份」（本机导出），
> **原生不支持 WebDAV / FTP / SMB**。本插件补上这条最通用的同步通道，可与群晖 Drive、Nextcloud、坚果云、
> 自建 FTP、Windows/NAS 的 SMB 共享等任意服务搭配。

| 项 | 值 |
| --- | --- |
| 插件 id | `com.siruoren.sync-favorites` |
| 端 | `renderer` |
| 应用最低版本 | `>=2.0.0` |
| 入口 | [`index.js`](./index.js) |
| 产物 | `dist/sync-favorites-<版本>.lxplugin`（版本 = app 版本，如 `sync-favorites-2.12.5.lxplugin`） |

## 安装与构建

```bash
node lx-plugins/repo-source-plugins/build.js sync-favorites
```

产物是单个文件 `lx-plugins/sync-favorites/dist/sync-favorites-<版本>.lxplugin`（版本 = app 版本），在客户端侧边栏「插件管理」里
上传安装 / 更新；开发期也可用「安装插件目录（本地开发）」直接选本目录。构建与安装的通用说明见
[`../README.md`](../README.md)，插件 API 细节见 [`../DEVELOPMENT.md`](../DEVELOPMENT.md)。

## 配置项（插件管理 → 我的列表同步 → 设置）

| 配置 | 说明 |
| --- | --- |
| 同步协议 `type` | **单选按钮**：WebDAV / FTP / SMB（默认 `webdav`）。点击切换协议后，**下方只显示当前协议需要填写的字段**（WebDAV：忽略证书；FTP：FTPS/被动模式；SMB：域/工作组），当前协议按钮呈灰置选中态，右侧显示「当前协议」 |
| 服务器地址 `host` | WebDAV 含协议，如 `http://192.168.31.120`、`https://dav.example.com`；FTP 仅主机名；**SMB 只填 IP/主机名，不要带 `smb://` 前缀**。注意：端口填到下方「端口」字段，不要拼进地址 |
| 端口 `port` | 留空用默认（WebDAV 依协议；FTP 默认 21；SMB 默认 445） |
| 远端目录 `remotePath` | 备份文件所在目录，默认 `lx-music/favorites`（不含文件名，上传时会自动逐级创建）。**WebDAV/群晖必须以「已存在的共享名」开头**，如 `homes/lx-music`、`photo/lx-music`；**SMB 首段是共享名**，如 `share/subdir`。填不准时先点「浏览目录」从根下列出的共享里抄一个。 |
| 文件名 `filename` | 备份文件名，默认 `lx_favorites.json` |
| 账号 / 密码 | 留空表示匿名 / 无认证 |
| 域/工作组 `domain` | 仅选 SMB 协议时显示，如 `WORKGROUP`；留空表示无 |
| 忽略证书校验 `insecure` | 仅选 WebDAV 协议时显示；自签名 HTTPS 证书时开启 |
| 启用 FTPS `secure` | 仅选 FTP 协议时显示；走 `AUTH TLS` 显式加密（控制 + 数据连接均加密） |
| 被动模式 `passive` | 仅选 FTP 协议时显示；默认开，连不上再尝试关 |
| 超时 `timeout` | 单次网络请求超时（毫秒），默认 `20000` |
| 同步方向 `mode` | `upload`=备份到远端；`download`=从远端还原到本地；`both`=双向合并（推荐）。双向/还原时若本地与远端都有改动，按「冲突策略」处理；内容无变化则跳过传输（增量） |
| 冲突策略 `conflictStrategy` | 本地与远端都改了同一列表时如何处理：`merge`=合并双方（并集，不丢歌）；`local`=以本地为准覆盖远端；`remote`=以远端为准覆盖本地 |
| 同步范围 `scope` | 逗号分隔，控制同步哪些列表：`default`=试听列表、`love`=我的收藏、`user`=我的列表（创建的歌单）；留空或 `all`=全部同步（默认 `default,love,user`）。**试听列表是临时播放队列，跨设备同步通常意义不大，可去掉 `default` 只写 `love,user`**。范围只影响选中类别，未选中的列表在还原/双向时保持本地原样、不会被清空 |
| 启用定时同步 / 间隔 | 开启后每 `间隔` 分钟在后台自动同步一次 |
| 加密 `encrypt` + 加密密码 | 备份文件用 AES-256-CBC 加密，即使服务端泄露也读不到收藏；还原需填相同密码 |

面板按钮：**立即备份** / **立即还原** / **测试连接** / **浏览目录**。

- **浏览目录**：列出「连接地址（或已填远端目录）」下的内容，方便你对照现有结构填写「远端目录」。填好协议 + 服务器地址后，面板也会**自动**列目录显示（地址变更防抖触发），无需手动点按钮。**若你填的远端目录不存在，会逐级向上回退直到 WebDAV 根 `/`，把群晖/Nextcloud 的真实共享（photo、music、homes、video…）列出来**，照着把「远端目录」改成 `共享名/子目录` 即可。
- 面板「目录列表」区实时显示最近一次浏览结果；底部「状态」显示上次执行结果与时间（成功/失败 + 解决冲突列表数 + 是否跳过无变化传输）。

## 实现要点

- **网络层零依赖**：WebDAV 走 Node 内置 `http/https`（PUT/GET/PROPFIND/MKCOL/DELETE + Basic Auth），
  FTP 走 `net/tls` 自实现 PASV 流程（STOR/RETR/MLSD·LIST/MKD/CWD/DELE，可选 FTPS）。
  **SMB 委派给系统自带工具**（零 npm 依赖）：优先 `smbclient`（samba，Linux 常见 / macOS 可 `brew install samba`），
  macOS 用系统自带的 `mount_smbfs`、Windows 用 `net use` 挂载后走 `fs`。若都不可用会给出明确报错。
  因此产物仍是单文件 `.lxplugin`，不需要任何 `node_modules`。
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

## 注意事项

- **群晖 / WebDAV 路径约定**：群晖的 WebDAV 共享挂在根 `/` 下（如 `homes`、`photo`、`music`、`video`）。「远端目录」必须**以已存在的共享名开头**，例如 `homes/lx-music` 或 `photo/lx-music`；直接填 `lx-music/favorites` 这种不存在的顶层路径会被服务器以 HTTP 405 拒绝（不是插件 bug，是服务器不允许在该位置创建集合）。先用「浏览目录」从根下列出的共享里选一个即可。若服务器需要登录，请务必在「账号 / 密码」填好——未登录时部分服务器对 PROPFIND/PUT 也返回 405/403。
- 「立即还原」/`both` 不再是无脑覆盖：冲突列表按「冲突策略」合并或覆盖，非冲突列表自动按各自改动合并，**不会无谓丢失一侧的收藏**。仍有风险（如策略选 `local`/`remote` 时，被覆盖一侧的该列表改动会丢失），故还原/双向前建议先「立即备份」一份本地数据。
- 同版本插件现已可走「上传更新」覆盖安装：插件管理版本门槛已放宽为「仅拒绝降级」（详见 [`../DEVELOPMENT.md` 9.2](../DEVELOPMENT.md#92-已知缺陷--坑) ②），更新会保留 `config.json` / `data.json`，不丢配置。注意 renderer 端插件更新后需**禁用 → 启用**或重启客户端才会生效（缺陷 ①）。
