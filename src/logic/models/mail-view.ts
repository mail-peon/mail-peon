import type { Mail } from './mail'
import type { Urgency } from './mail-state'
import type { AppSettings } from './settings'
import { codeMatchOf } from './mail'
import { hasMailState, MailStateFlag } from './mail-state'
// ---------------------------------------------------------------------------
// 派生 UI 字段（不存储，按需计算）
// ---------------------------------------------------------------------------

export type MailVisibility = 'normal' | 'ad' | 'code' | 'pending'

/**
 * 一封邮件在 UI 上归到哪个分区。
 *
 * 刻意做成纯函数、不落库（`design/minimal-mode.md` 与 `features/04` 都要求
 * 「不存 `_visibility`，避免脏数据」）：它是 `ai` / `copyStatus` / 设置三者的
 * 函数，存下来就会有「设置改了但字段没跟着改」的窗口。
 */
export function mailVisibility(mail: Mail, app: Pick<AppSettings, 'excludeAds'>): MailVisibility {
  if (mail.processing === 'pending' && !mail.ai)
    return 'pending'
  if (hasMailState(mail.stateFlags, MailStateFlag.Ad) && app.excludeAds)
    return 'ad'
  if (codeMatchOf(mail))
    return 'code'
  return 'normal'
}

export const URGENCY_RANK: Record<Urgency, number> = { high: 2, normal: 1, low: 0 }

/**
 * 紧急度排序值（`high=2 / normal=1 / low=0`）。
 *
 * 从位掩码反推：`Urgent` → high，`LowPriority` → low，其余 normal。
 */
export function urgencyRank(mail: Pick<Mail, 'stateFlags'>): number {
  if (hasMailState(mail.stateFlags, MailStateFlag.Urgent))
    return URGENCY_RANK.high
  if (hasMailState(mail.stateFlags, MailStateFlag.LowPriority))
    return URGENCY_RANK.low
  return URGENCY_RANK.normal
}

/**
 * badge 数字（`features/02-ai-summary.md § 6.2`）。
 *
 * **不计入**：未处理 pending、广告（开启排除时）、已验证码（自动复制成功时）。
 */
export function badgeCount(mails: Mail[], app: Pick<AppSettings, 'excludeAds'>): number {
  return mails.filter((mail) => {
    if (mail.read || mail.dismissed)
      return false
    if (mail.processing === 'pending')
      return false
    if (hasMailState(mail.stateFlags, MailStateFlag.Ad) && app.excludeAds)
      return false
    // 验证码：复制成功的不打扰；复制失败的仍要提醒（用户得手动复制）
    if (codeMatchOf(mail) && mail.copyStatus === 'copied')
      return false
    return true
  }).length
}
