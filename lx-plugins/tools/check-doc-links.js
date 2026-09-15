#!/usr/bin/env node
/**
 * 校验 markdown 文档里的相对链接（文件是否存在）与页内锚点（标题是否匹配）。
 *
 * 用法：
 *   node lx-plugins/tools/check-doc-links.js                      # 默认校验 lx-plugins/**\/*.md
 *   node lx-plugins/tools/check-doc-links.js lx-plugins README.md doc
 *   node lx-plugins/tools/check-doc-links.js --quiet lx-plugins   # 只打印失败项
 *
 * 锚点算法对齐 GitHub（github-slugger）：
 *   1. 小写
 *   2. 删掉标点（. 、 / （） 「」 ` —— 等），保留各语言字母/数字/下划线/连字符/空格
 *   3. **每个空格替换为一个连字符（不折叠连续空格！）**
 *      例：`### 5.4 `api.patch` —— 运行时覆盖原功能` → `54-apipatch--运行时覆盖原功能`
 * 注意第 3 条是最容易写错的地方（折叠空格会误报大量锚点失效）。
 *
 * 依赖：仅 Node 内置模块。
 */
'use strict'

const fs = require('fs')
const path = require('path')

const ROOT = path.resolve(__dirname, '..', '..')

const argv = process.argv.slice(2)
const quiet = argv.includes('--quiet')
const targets = argv.filter((a) => !a.startsWith('--'))
const inputs = targets.length > 0 ? targets : ['lx-plugins']

/** GitHub 风格锚点 */
function slug(text) {
  return text
    .trim()
    .toLowerCase()
    // 去掉标点；\p{L}\p{N} 覆盖 CJK 与各语言字母数字
    .replace(/[^\p{L}\p{N}\s_-]/gu, '')
    // 关键：逐空格替换，不折叠（GitHub 行为）
    .replace(/[ \t]/g, '-')
}

/** 收集某个 md 文件里所有标题的锚点（跳过代码围栏内的 # 行） */
function anchorsOf(file) {
  const out = new Set()
  let inFence = false
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (/^\s*(```|~~~)/.test(line)) {
      inFence = !inFence
      continue
    }
    if (inFence) continue
    const m = /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line)
    if (m) out.add(slug(m[2]))
  }
  return out
}

const anchorCache = new Map()
function anchorsFor(file) {
  if (!anchorCache.has(file)) anchorCache.set(file, anchorsOf(file))
  return anchorCache.get(file)
}

function walk(p, acc) {
  const st = fs.statSync(p)
  if (st.isFile()) {
    if (p.endsWith('.md')) acc.push(p)
    return acc
  }
  for (const e of fs.readdirSync(p, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name === '.git') continue
    walk(path.join(p, e.name), acc)
  }
  return acc
}

const files = []
for (const t of inputs) {
  const abs = path.resolve(ROOT, t)
  if (!fs.existsSync(abs)) {
    console.error(`跳过（不存在）：${t}`)
    continue
  }
  walk(abs, files)
}

let total = 0
let bad = 0
const problems = []

for (const file of files) {
  const rel = path.relative(ROOT, file)
  const src = fs.readFileSync(file, 'utf8')
  // 只取 markdown 链接的圆括号部分，跳过代码围栏
  let inFence = false
  const lines = src.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (/^\s*(```|~~~)/.test(line)) {
      inFence = !inFence
      continue
    }
    if (inFence) continue
    const re = /\]\(([^()\s]+)\)/g
    let m
    while ((m = re.exec(line)) !== null) {
      const href = m[1]
      total++
      if (/^(https?:|mailto:|#?$)/.test(href)) continue

      const [rawPath, rawAnchor] = href.split('#')
      const targetPath = rawPath
        ? path.resolve(path.dirname(file), decodeURIComponent(rawPath))
        : file

      if (!fs.existsSync(targetPath)) {
        bad++
        problems.push(`${rel}:${i + 1} 目标文件不存在 → ${href}`)
        continue
      }
      if (rawAnchor && targetPath.endsWith('.md')) {
        const want = decodeURIComponent(rawAnchor).toLowerCase()
        if (!anchorsFor(targetPath).has(want)) {
          bad++
          problems.push(`${rel}:${i + 1} 锚点不存在 → ${href}`)
          continue
        }
      }
      if (!quiet) console.log(`✓ ${rel}:${i + 1} ${href}`)
    }
  }
}

console.log('')
for (const p of problems) console.error(`✗ ${p}`)
console.log(`共检查 ${files.length} 个文档、${total} 个链接，${bad} 个失效`)
process.exit(bad === 0 ? 0 : 1)
