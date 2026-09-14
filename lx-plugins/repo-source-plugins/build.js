#!/usr/bin/env node
/**
 * lx-plugins 插件构建脚本（零依赖，不需要 npm install）。
 *
 * 产物：**单个文件** —— `lx-plugins/<项目目录名>/dist/<项目目录名>.lxplugin`，
 * 在客户端「设置 → 插件管理」里上传（或拖拽）该文件即可安装 / 更新。
 *
 * .lxplugin 的结构（见 src/plugins/format.ts）：
 *
 *   /*!lxplugin
 *   { ...内嵌的 plugin.json... }
 *   *\/
 *   ...插件模块代码（CommonJS）...
 *
 * 横幅是合法 JS 注释，因此该文件本身也是一个可直接执行的 JS 模块；
 * 运行时只做「文本解析 + JSON.parse」取出清单，安装阶段不会执行插件代码。
 *
 * 用法：
 *   node lx-plugins/repo-source-plugins/build.js            # 构建脚本所在的项目
 *   node lx-plugins/repo-source-plugins/build.js <项目名>    # 构建 lx-plugins 下的指定项目
 *   node lx-plugins/repo-source-plugins/build.js <项目名> --out /tmp/out
 *
 * 项目结构（本仓库：项目根即插件）：
 *   lx-plugins/<项目目录名>/plugin.json    # 清单（id / name / version 必填）
 *   lx-plugins/<项目目录名>/index.js       # 入口代码（默认；可用 build.entry 指向源码目录）
 *
 * 如需把多文件源码打包成一个文件，可先用任意打包器（esbuild / rollup / webpack）产出
 * 单个 CommonJS 文件，再让 build.entry 指向它，本脚本只负责套上清单横幅。
 */
'use strict'

const fs = require('fs')
const path = require('path')

/** lx-plugins 目录（本脚本位于 lx-plugins/<项目>/ 下） */
const PLUGINS_ROOT = path.resolve(__dirname, '..')
const BANNER_BEGIN = '/*!lxplugin'
const BANNER_END = '*/'
const VALID_ID = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/
const VALID_VERSION = /^\d+(\.\d+)*([+-][0-9A-Za-z.-]+)?$/

function fail(message) {
  console.error(`[build-plugin] 构建失败：${message}`)
  process.exit(1)
}

function log(message) {
  console.log(`[build-plugin] ${message}`)
}

function readJSON(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf-8'))
  } catch (err) {
    fail(`${path.basename(file)} 解析失败：${err.message}`)
  }
}

function formatSize(bytes) {
  if (bytes < 1024) return `${bytes} B`
  return `${(bytes / 1024).toFixed(1)} KB`
}

/** 校验清单，返回规范化后的清单（main 固定为安装后的入口文件名） */
function normalizeManifest(raw, projectName) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) fail(`${projectName}/plugin.json 内容非法`)
  if (typeof raw.id !== 'string' || !VALID_ID.test(raw.id)) {
    fail(`${projectName}/plugin.json 的 id 非法（仅允许字母、数字、.、_、-）：${raw.id}`)
  }
  if (typeof raw.name !== 'string' || !raw.name) fail(`${projectName}/plugin.json 缺少 name`)
  if (typeof raw.version !== 'string' || !VALID_VERSION.test(raw.version.trim())) {
    fail(`${projectName}/plugin.json 的 version 非法（应形如 1.0.0）：${raw.version}`)
  }
  const main = raw.main || 'index.js'
  if (/[/\\]/.test(main) || !/\.(js|cjs|mjs)$/.test(main)) {
    fail(`${projectName}/plugin.json 的 main 必须是不含路径分隔符的 .js/.cjs 文件名：${main}`)
  }
  const platforms = Array.isArray(raw.platforms) && raw.platforms.length ? raw.platforms : ['renderer']
  for (const p of platforms) {
    if (p !== 'main' && p !== 'renderer') fail(`${projectName}/plugin.json 的 platforms 含未知值：${p}`)
  }

  // 注意：build 字段仅用于构建期定位源码，不会写入产物清单
  const manifest = {
    id: raw.id,
    name: raw.name,
    version: raw.version.trim(),
  }
  if (raw.description) manifest.description = raw.description
  if (raw.author) manifest.author = raw.author
  if (raw.homepage) manifest.homepage = raw.homepage
  manifest.main = main
  if (raw.engines) manifest.engines = raw.engines
  manifest.platforms = platforms
  return manifest
}

/** 解析要构建的项目目录 */
function resolveProjects(arg) {
  if (!arg) return [__dirname]
  if (arg.startsWith('.') || arg.includes(path.sep) || path.isAbsolute(arg)) {
    const dir = path.resolve(process.cwd(), arg)
    if (!fs.existsSync(path.join(dir, 'plugin.json'))) fail(`目录中没有 plugin.json：${dir}`)
    return [dir]
  }
  const dir = path.join(PLUGINS_ROOT, arg)
  if (!fs.existsSync(path.join(dir, 'plugin.json'))) fail(`lx-plugins 下没有该插件项目：${arg}`)
  return [dir]
}

function buildProject(projectDir, outDir) {
  const projectName = path.basename(projectDir)
  const raw = readJSON(path.join(projectDir, 'plugin.json'))
  const manifest = normalizeManifest(raw, projectName)

  // 源码入口：build.entry 优先（可指向源码目录），否则用 main
  const entryRel = (raw.build && raw.build.entry) || manifest.main
  const entryFile = path.resolve(projectDir, entryRel)
  if (!entryFile.startsWith(projectDir + path.sep)) fail(`入口路径越界：${entryRel}`)
  if (!fs.existsSync(entryFile)) fail(`入口文件不存在：${entryRel}`)

  const code = fs.readFileSync(entryFile, 'utf-8')
  if (!code.trim()) fail(`入口文件内容为空：${entryRel}`)
  if (/\brequire\s*\(/.test(code)) {
    log(`提示：${projectName} 的入口代码包含 require()，单文件插件安装后没有同级依赖文件，请确认依赖已内联`)
  }

  const artifact = [
    BANNER_BEGIN,
    JSON.stringify(manifest, null, 2),
    BANNER_END,
    code,
  ].join('\n')

  const outFile = path.join(outDir, `${projectName}.lxplugin`)
  fs.mkdirSync(outDir, { recursive: true })
  fs.writeFileSync(outFile, artifact, 'utf-8')

  log(`已构建 ${projectName}@${manifest.version} → ${path.relative(process.cwd(), outFile)}`)
  log(`  id: ${manifest.id} | 端: ${manifest.platforms.join(' / ')} | 入口: ${entryRel} | 体积: ${formatSize(Buffer.byteLength(artifact, 'utf-8'))}`)
  return outFile
}

function main() {
  const args = process.argv.slice(2)
  let outArg = null
  let nameArg = null
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--out') outArg = args[++i]
    else if (!nameArg) nameArg = args[i]
  }

  const projects = resolveProjects(nameArg)
  const files = projects.map(dir => {
    const outDir = outArg ? path.resolve(process.cwd(), outArg) : path.join(dir, 'dist')
    return buildProject(dir, outDir)
  })
  log(`全部完成，共 ${files.length} 个产物`)
}

main()
