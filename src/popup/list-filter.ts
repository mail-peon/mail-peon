import type { AiOutput, AppSettings, Mail, PopupTab } from '~/logic/types'
import { badgeCount, mailVisibility } from '~/logic/types'

/**
 * 邮件列表的**筛选与排序**（Popup 与 Sidepanel 共用）。
 *
 * 单独一个模块而不是在每个组件里写 `computed`：两个界面的分区规则必须完全一致
 * （「重要」tab 里有哪几封，Popup 与 Sidepanel 给不同答案的话，用户会以为丢邮件了）。
 * 纯函数也意味着「广告不进主列表」「验证码单独分区」这些产品规则可以被单测断言，
 * 而不用起浏览器。
 */

export interface MailTabCounts {
  important: number
  all: number
  code: number
  ad: number
}

/** tab 的展示顺序（与设计文档 `ui-flows.md § 1.1` 一致） */
export const TAB_ORDER: readonly PopupTab[] = ['important', 'all', 'code', 'ad'] as const

/**
 * 按 tab 筛邮件。
 *
 * 各 tab 的定义（`ui-flows.md § 1.1` + `features/04 § 5`）：
 *
 *   - `all`       全部未 dismiss 的邮件
 *   - `important` `urgency !== 'low'` 且**不是**广告（`excludeAds` 开启时）
 *   - `code`      有验证码的邮件（不排除广告 —— 广告里的验证码同样要给用户）
 *   - `ad`        被判为广告的邮件
 *
 * ⚠ `dismissed` 的邮件在**所有** tab 里都不出现。设计文档把它定义为「用户标记
 *   不再显示」，如果只在某个 tab 里隐藏，用户会疑惑「我明明标了不再显示」。
 */
export function filterMails(mails: Mail[], tab: PopupTab, app: Pick<AppSettings, 'excludeAds'>): Mail[] {
  const visible = mails.filter(mail => !mail.dismissed)

  switch (tab) {
    case 'all':
      return visible
    case 'code':
      return visible.filter(mail => !!mail.ai?.code)
    case 'ad':
      return visible.filter(mail => mailVisibility(mail, app) === 'ad')
    case 'important':
    default:
      return visible.filter((mail) => {
        const visibility = mailVisibility(mail, app)
        // 广告与「AI 还没回」的都不算重要
        if (visibility === 'ad' || visibility === 'pending')
          return false
        // 验证码一定重要：用户正等着它
        if (visibility === 'code')
          return true
        return (mail.ai?.urgency ?? 'normal') !== 'low'
      })
  }
}

/** 各 tab 的角标数字（tab 标签上的 `重要 5` 那个 5） */
export function countByTab(mails: Mail[], app: Pick<AppSettings, 'excludeAds'>): MailTabCounts {
  return {
    important: filterMails(mails, 'important', app).length,
    all: filterMails(mails, 'all', app).length,
    code: filterMails(mails, 'code', app).length,
    ad: filterMails(mails, 'ad', app).length,
  }
}

/**
 * 列表排序：时间倒序。
 *
 * 刻意**不按 urgency 排**：用户对「邮件」的心智模型是时间线，
 * 按紧急度排会让列表在每次新邮件到达时整个重排（用户刚看到第 3 条，
 * 来了一封 high 的，它跳到了第 1 条 —— 视线跟丢了）。
 * 紧急度用颜色和角标表达就够了。
 */
export function sortMails(mails: Mail[]): Mail[] {
  return [...mails].sort((a, b) => b.receivedAt - a.receivedAt)
}

/**
 * 极简模式的列表：**只挑有验证码的**。
 *
 * `design/minimal-mode.md § 4.3`：只显示最近 50 条验证码，按时间倒序；
 * 不显示未含验证码的邮件。上限由写入侧的 `MINIMAL_RETENTION` 保证，
 * 这里只做筛选与排序。
 */
export function minimalModeMails(mails: Mail[]): Mail[] {
  return sortMails(mails.filter(mail => !!mail.ai?.code || !!mail.code))
}

/** tab 的展示名（i18n 键） */
export function tabLabelKey(tab: PopupTab): string {
  switch (tab) {
    case 'all': return 'popup.tabAll'
    case 'code': return 'popup.tabCode'
    case 'ad': return 'popup.tabAd'
    case 'important':
    default: return 'popup.tabImportant'
  }
}

/** tab 的空白态文案（i18n 键） */
export function tabEmptyKey(tab: PopupTab): string {
  switch (tab) {
    case 'all': return 'popup.emptyAll'
    case 'code': return 'popup.emptyCode'
    case 'ad': return 'popup.emptyAd'
    case 'important':
    default: return 'popup.emptyImportant'
  }
}

/**
 * badge 数字 → 展示文本（`0` 显示为空）。
 *
 * 与 `logic/notification/badge.ts` 的 `formatBadgeText` 同源，但这里服务的是
 * **列表标题上的角标**（不是 icon badge），所以上限不同：icon badge 最多显示
 * 4 个字符（99+），而列表角标能显示更多。
 */
export function displayCount(count: number): string {
  return count > 0 ? String(count) : ''
}

/** 一封邮件的 AI 状态摘要（列表项第二行） */
export function mailSummaryLine(mail: Mail): string {
  if (mail.ai?.minimal)
    return mail.ai.minimal
  if (mail.ai?.summary)
    return mail.ai.summary.split('\n')[0] ?? ''
  return mail.snippet
}

/** 「这封邮件是降级的吗」——UI 上给 ⚠️ 角标 */
export function isDegraded(ai: AiOutput | undefined): boolean {
  return ai?.degraded === true
}

export { badgeCount }
