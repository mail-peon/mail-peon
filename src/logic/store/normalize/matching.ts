import type { BlockedEntry, Matcher } from '~/logic/types'
import { isPlainObject, str } from './common'

export function normalizeMatchers(raw: unknown): Matcher[] {
  if (!Array.isArray(raw))
    return []
  const out: Matcher[] = []
  for (const item of raw) {
    if (typeof item === 'string') {
      // 允许 UI 只给一个字符串。
      // ⚠ 判据是「以 @ 开头」而不是「含 @」：用户写 `@github.com` 时本意是域名，
      //   而它含 `@` —— 按「含 @ 即邮箱」判会把这条规则变成「匹配发件人地址恰好
      //   等于 @github.com」，即永远不命中。用户的规则会静默失效。
      const value = item.trim().toLowerCase()
      if (!value)
        continue
      if (value.startsWith('@'))
        out.push({ kind: 'domain', value: value.slice(1) })
      else if (value.includes('@'))
        out.push({ kind: 'email', value })
      else
        out.push({ kind: 'domain', value })
      continue
    }
    if (!isPlainObject(item))
      continue
    const value = str(item.value).trim().toLowerCase()
    if (!value)
      continue
    const kind = item.kind === 'email' || item.kind === 'domain' || item.kind === 'regex'
      ? item.kind
      : 'domain'
    // 域名前带 @（`@github.com`）时把 @ 摘掉
    out.push({ kind, value: kind === 'domain' ? value.replace(/^@/, '') : value })
  }
  return dedupeMatchers(out)
}

export function dedupeMatchers(matchers: Matcher[]): Matcher[] {
  const seen = new Set<string>()
  return matchers.filter((matcher) => {
    const key = `${matcher.kind}\u0000${matcher.value}`
    if (seen.has(key))
      return false
    seen.add(key)
    return true
  })
}

export function normalizeBlockedList(raw: unknown): BlockedEntry[] {
  return normalizeMatchers(raw)
    .filter((matcher): matcher is BlockedEntry => matcher.kind !== 'regex')
    .map(matcher => ({ kind: matcher.kind, value: matcher.value }))
}

/**
 * 文本行 → 屏蔽项（「批量粘贴」用）。
 *
 * 识别规则（`features/06-blocked-senders.md § 5`）：**以 @ 开头**视为域名，
 * 否则含 `@` 视为邮箱，都不含则视为域名。每行一项，`#` 开头当注释、空行忽略。
 *
 * ⚠ 判据是「以 @ 开头」而不是「含 @」：`@tracker.com` 是用户实际会写的形态
 *   （文档 § 4 的 UI 示例就是它），而它含 `@` —— 按「含 @ 即邮箱」判会把它
 *   变成一个永远不命中的邮箱条目。
 *
 * 非法行（含 `<>` 之类）直接丢弃：把它们原样存进列表的话，用户在 UI 上会看到
 * 一条看起来正常、实际永远不命中的规则，而发现问题只能靠自己逐个核对。
 */
export function parseBlockedListText(text: string): BlockedEntry[] {
  return normalizeBlockedList(
    text
      .split(/[\n,;]+/)
      .map(line => line.trim())
      .filter(line => line && !line.startsWith('#'))
      .filter(line => isLikelyAddressOrDomain(line)),
  )
}

/** 地址 / 域名的粗校验：只允许字母数字、点、连字符、下划线，以及一个 `@` */
export function isLikelyAddressOrDomain(value: string): boolean {
  const candidate = value.startsWith('@') ? value.slice(1) : value
  if (!candidate || !/^[\w.-]+$/.test(candidate.replace('@', '')))
    return false
  // 至多一个 @，且不在开头 / 结尾
  const at = candidate.indexOf('@')
  if (at === -1)
    return true
  return at === candidate.lastIndexOf('@') && at > 0 && at < candidate.length - 1
}
