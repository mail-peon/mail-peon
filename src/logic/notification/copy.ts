import type { Mail, MailAddress } from '~/logic/types'

/**
 * toast / badge / 列表里「发件人叫什么」的统一口径。
 *
 * 为什么值得单独一个函数：同一个发件人在三个地方展示（toast 标题、badge tooltip、
 * Popup 列表项），三处各写一遍 `from[0]?.name || from[0]?.address` 的结果是
 * **三处行为不一致** —— 有的显示 `noreply@github.com`、有的显示 `GitHub`，
 * 用户会觉得是两个不同的东西。
 */

/**
 * 短标签：优先用显示名，没有则用地址的 `@` 前部分。
 *
 * 用在**空间紧张**的地方（列表项左侧、toast 第一行）：
 *   GitHub · noreply@github.com
 *   ^^^^^^ 这里
 */
export function senderLabel(from: MailAddress[]): string {
  const first = from[0]
  if (!first)
    return '(未知发件人)'

  if (first.name?.trim())
    return first.name.trim()

  const address = first.address?.trim()
  if (!address)
    return '(未知发件人)'

  // `noreply@github.com` → `noreply`；`me@x.com` → `me`
  return address.split('@')[0] || address
}

/**
 * toast 标题：`显示名 · 邮箱地址`。
 *
 * 两个都给是有意的（`design/page-toast.md § 3.3` 的图里就是这个形态）：
 * 显示名会**骗人** —— 营销邮件可以随便把自己叫成 "GitHub"，
 * 而邮箱地址是用户能验证的那部分。只显示显示名等于把辨别成本转嫁给用户。
 */
export function toastCaption(from: MailAddress[]): string {
  const first = from[0]
  if (!first)
    return '(未知发件人)'

  const name = first.name?.trim()
  const address = first.address?.trim()

  if (name && address)
    return `${name} · ${address}`
  return name || address || '(未知发件人)'
}

/**
 * 邮件列表项的主标题：主题，空则退化到 `(无主题)`。
 *
 * 单独一个函数是为了让「空主题显示什么」只有一个答案 —— 搜索 / 筛选 / 列表项
 * 如果各自判断，会出现「列表里显示 (无主题)、搜索时又搜不到」这种不一致。
 */
export function mailTitle(mail: Pick<Mail, 'subject'>): string {
  const subject = mail.subject?.trim()
  return subject || '(无主题)'
}
