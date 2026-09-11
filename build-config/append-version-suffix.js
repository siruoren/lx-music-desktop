// 在 CI（githubflow）打包前，把 package.json 的 version 追加一个后缀，
// 使打包出的应用版本（含 UI 展示、安装包文件名、GitHub Release 标签）统一带后缀。
// 例如当前版本 2.12.2 -> 2.12.2-siruoren
// 可通过环境变量 APP_VERSION_SUFFIX 覆盖默认后缀。

const fs = require('fs')
const path = require('path')

const SUFFIX = process.env.APP_VERSION_SUFFIX || '-siruoren'
const pkgPath = path.resolve(__dirname, '..', 'package.json')
const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'))

if (!pkg.version.endsWith(SUFFIX)) {
  pkg.version += SUFFIX
  fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n')
  console.log(`[append-version-suffix] App version set to ${pkg.version}`)
} else {
  console.log(`[append-version-suffix] App version already has suffix: ${pkg.version}`)
}
