import type { BlockedEntry, Mail } from '~/logic/types'
import { addressDomain } from '~/adapters/mail/parser'

/**
 * 排除邮箱匹配（`ai-docs/features/06-blocked-senders.md § 3`）。
 *
 * 列表挂在**每个账号**上（`MailAccount.blockedList`），不是全局的 ——
 * 设计决策见 `decisions/open-questions.md` Q7。理由是同一个发件人在不同账号里
 * 的意义完全不同：`noreply@company.com` 在工作邮箱里是要看的，在注册用的
 * 个人邮箱里就是噪音。
 *
 * 命中的邮件**完全跳过**：不入库、不调 AI、不弹 toast、不计 badge、不进任何视图。
 */

/** 取邮件的发件人地址（小写）；没有则空串 */
export function senderAddress(mail: Pick<Mail, 'from'>): string {
  return mail.from[0]?.address?.trim().toLowerCase() ?? ''
}

export function senderDomain(mail: Pick<Mail, 'from'>): string {
  return addressDomain(senderAddress(mail))
}

/**
 * 是否被屏蔽。
 *
 * 域名匹配支持**子域**：`tracker.com` 同时匹配 `a.tracker.com` / `b.c.tracker.com`。
 * 用 `=== v || endsWith('.' + v)` 而不是裸 `endsWith(v)`：后者会把
 * `nottracker.com` 也当成 `tracker.com` 的子域 —— 那是个静默的过度屏蔽，
 * 用户只会觉得「某些邮件莫名其妙消失了」。
 */
export function isBlocked(mail: Pick<Mail, 'from'>, list: BlockedEntry[] | undefined): boolean {
  if (!list?.length)
    return false

  const address = senderAddress(mail)
  if (!address)
    return false

  const domain = addressDomain(address)

  return list.some((entry) => {
    const value = entry.value.trim().toLowerCase().replace(/^@/, '')
    if (!value)
      return false
    if (entry.kind === 'email')
      return address === value
    return domain === value || domain.endsWith(`.${value}`)
  })
}

/** 命中列表里的哪一条（UI 上标「已屏蔽」用） */
export function matchedBlockedEntry(mail: Pick<Mail, 'from'>, list: BlockedEntry[] | undefined): BlockedEntry | undefined {
  if (!list?.length)
    return undefined
  const address = senderAddress(mail)
  const domain = addressDomain(address)
  return list.find((entry) => {
    const value = entry.value.trim().toLowerCase().replace(/^@/, '')
    if (entry.kind === 'email')
      return address === value
    return domain === value || domain.endsWith(`.${value}`)
  })
}

/**
 * 批量粘贴文本 → 列表项（`features/06 § 5`）。
 *
 * 识别规则：含 `@` 当邮箱，否则当域名。**刻意不做「@github.com → 域名」的智能推断**：
 * `@github.com` 里含 `@`，按规则会被当邮箱，而用户的本意显然是域名。
 * 所以先把开头的 `@` 摘掉再判断 —— 这是用户实际会写的写法（文档 § 4 的 UI 示例
 * 就是 `@tracker.com`）。
 */
export function parseBlockedText(text: string): BlockedEntry[] {
  const out: BlockedEntry[] = []
  for (const rawLine of text.split(/[\n,;]+/)) {
    const line = rawLine.trim().replace(/^#.*$/, '')
    if (!line)
      continue

    const value = line.replace(/^@/, '').toLowerCase()
    // 只允许 `local@domain` 或 `domain` 两种形态；别的一律丢弃
    if (!value || !/^[\w.-]+(?:@[\w.-]+)?$/.test(value))
      continue

    // 摘掉开头的 @ 之后还有 @ ⇒ 真的是邮箱；否则是域名
    out.push(value.includes('@') ? { kind: 'email', value } : { kind: 'domain', value })
  }
  return dedupe(out)
}

function dedupe(entries: BlockedEntry[]): BlockedEntry[] {
  const seen = new Set<string>()
  return entries.filter((entry) => {
    const key = `${entry.kind}\u0000${entry.value}`
    if (seen.has(key))
      return false
    seen.add(key)
    return true
  })
}
