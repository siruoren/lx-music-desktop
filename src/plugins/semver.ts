/**
 * 极简语义化版本比较（仅依赖标准库，避免引入第三方依赖）。
 * 支持 1.2 / 1.2.3 / 1.2.3-beta.1 形式。
 */

function parse(version: string): number[] {
  const core = String(version).trim().replace(/^v/, '').split('-')[0]
  return core.split('.').map(n => {
    const v = parseInt(n, 10)
    return Number.isNaN(v) ? 0 : v
  })
}

/** a > b 返回 1，a < b 返回 -1，相等返回 0 */
export function compareVersion(a: string, b: string): number {
  const va = parse(a)
  const vb = parse(b)
  const len = Math.max(va.length, vb.length)
  for (let i = 0; i < len; i++) {
    const x = va[i] ?? 0
    const y = vb[i] ?? 0
    if (x > y) return 1
    if (x < y) return -1
  }
  return 0
}

/** a 是否大于等于 b */
export function gteVersion(a: string, b: string): boolean {
  return compareVersion(a, b) >= 0
}

/** 判断 version 是否满足约束，如 ">=2.0.0"、"2.12.5"、"^2.0.0" */
export function satisfies(version: string, range: string): boolean {
  const r = String(range).trim()
  if (!r) return true
  if (r.startsWith('>=')) return gteVersion(version, r.slice(2).trim())
  if (r.startsWith('>')) return compareVersion(version, r.slice(1).trim()) > 0
  if (r.startsWith('<=')) return compareVersion(version, r.slice(2).trim()) <= 0
  if (r.startsWith('<')) return compareVersion(version, r.slice(1).trim()) < 0
  if (r.startsWith('^')) {
    const base = parse(r.slice(1).trim())
    // ^2.0.0 -> >=2.0.0 且 <3.0.0
    if (base[0] === 0) return gteVersion(version, r.slice(1).trim()) && compareVersion(version, `${base[0] + 1}.0.0`) < 0
    return gteVersion(version, r.slice(1).trim()) && compareVersion(version, `${base[0] + 1}.0.0`) < 0
  }
  // 精确匹配
  return compareVersion(version, r) === 0
}
