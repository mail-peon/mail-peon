import type { AppSettings, Mail, MailFilterId, MailTypeAdapter } from '~/logic/types'
import { t } from '~/logic/strings'
import {
  badgeCount,
  codeMatchOf,
  hasActionableType,
  hasMailState,
  MailStateFlag,
  mailTypeMatches,
  matchesOfKind,
  summaryMatchOf,
} from '~/logic/types'

/**
 * 邮件列表的**筛选与排序**（Popup / Sidepanel 共用）。
 *
 * Feature 08 起，筛选不再硬编码四个 tab，而是由三类标签动态组成：
 *
 *   1. **邮件状态**：`重要`（派生条件）、`营销`（`Ad` 位）
 *   2. **内置适配器**：验证码 / 确认邮件
 *   3. **自定义适配器**：用户自己的类型名
 *
 * `总结` 不作为筛选标签：它是兜底内容，不是用户会主动找的东西。
 */

export interface MailFilter {
  id: MailFilterId
  label: string
  count: number
  kind: 'state' | 'adapter'
}

export function filterIdForAdapter(adapterId: string): MailFilterId {
  return `adapter:${adapterId}`
}

/** 从 `adapter:<id>` 反解；不是适配器筛选时返回 null */
export function adapterIdOfFilter(filter: MailFilterId): string | null {
  if (!filter.startsWith('adapter:'))
    return null
  const id = filter.slice('adapter:'.length)
  return id || null
}

/**
 * 「重要」筛选。
 *
 * 规则（与旧版行为保持一致）：
 *   - 未处理 / 已 dismiss 的不算；
 *   - 广告（且用户开了排除）不算；
 *   - 低优先级不算，**但**验证码 / 确认邮件例外 —— 用户正等着它。
 */
export function isImportant(mail: Mail, app: Pick<AppSettings, 'excludeAds'>): boolean {
  if (mail.dismissed)
    return false
  if (mail.processing === 'pending' && !mail.ai)
    return false
  if (hasMailState(mail.stateFlags, MailStateFlag.Ad) && app.excludeAds)
    return false
  if (hasMailState(mail.stateFlags, MailStateFlag.LowPriority) && !hasActionableType(mail))
    return false
  return true
}

/** 按筛选 id 过滤（`all` / `important` / `ad` / `adapter:<id>`） */
export function filterMails(
  mails: Mail[],
  filter: MailFilterId,
  app: Pick<AppSettings, 'excludeAds'>,
): Mail[] {
  const visible = mails.filter(mail => !mail.dismissed)

  if (filter === 'all')
    return visible

  if (filter === 'important')
    return visible.filter(mail => isImportant(mail, app))

  if (filter === 'ad')
    return visible.filter(mail => hasMailState(mail.stateFlags, MailStateFlag.Ad))

  const adapterId = adapterIdOfFilter(filter)
  if (adapterId)
    return visible.filter(mail => mailTypeMatches(mail).some(match => match.adapterId === adapterId))

  // 未知筛选（比如指向已删除的适配器）→ 回退到全部
  return visible
}

/**
 * 动态生成筛选标签（含每个标签的计数）。
 *
 * 顺序：重要 → 全部 → 适配器（按优先级）→ 营销。
 * 与旧版「重要 / 全部 / 验证码 / 营销」的肌肉记忆保持一致，只是中间插入了
 * 内置 + 自定义适配器。
 */
export function buildMailFilters(
  mails: Mail[],
  adapters: MailTypeAdapter[],
  app: Pick<AppSettings, 'excludeAds'>,
): MailFilter[] {
  const visible = mails.filter(mail => !mail.dismissed)

  const filters: MailFilter[] = [
    {
      id: 'important',
      label: t('popup.tabImportant'),
      count: visible.filter(mail => isImportant(mail, app)).length,
      kind: 'state',
    },
    {
      id: 'all',
      label: t('popup.tabAll'),
      count: visible.length,
      kind: 'state',
    },
  ]

  for (const adapter of adapters) {
    if (!adapter.enabled || adapter.ui === 'summary')
      continue
    filters.push({
      id: filterIdForAdapter(adapter.id),
      label: adapter.name,
      count: visible.filter(mail => mailTypeMatches(mail).some(match => match.adapterId === adapter.id)).length,
      kind: 'adapter',
    })
  }

  filters.push({
    id: 'ad',
    label: t('popup.tabAd'),
    count: visible.filter(mail => hasMailState(mail.stateFlags, MailStateFlag.Ad)).length,
    kind: 'state',
  })

  return filters
}

/**
 * 选一个**当前存在**的默认筛选。
 *
 * `popupDefaultTab` 可能指向一个被删掉的适配器；那时回退到「重要」。
 */
export function resolveFilterId(
  filters: MailFilter[],
  requested: string | undefined,
): MailFilterId {
  if (requested && filters.some(filter => filter.id === requested))
    return requested as MailFilterId
  return 'important'
}

/**
 * 列表排序：时间倒序。
 *
 * 刻意**不按 urgency 排**：用户对「邮件」的心智模型是时间线，
 * 按紧急度排会让列表在每次新邮件到达时整个重排（用户刚看到第 3 条，
 * 来了一封 high 的，它跳到了第 1 条 —— 视线跟丢了）。
 */
export function sortMails(mails: Mail[]): Mail[] {
  return [...mails].sort((a, b) => b.receivedAt - a.receivedAt)
}

/**
 * 极简模式的列表：验证码 + 确认。
 *
 * 只显示这两类（没有命中就不入库）；上限由写入侧的 `MINIMAL_RETENTION` 保证。
 */
export function minimalModeMails(mails: Mail[]): Mail[] {
  return sortMails(mails.filter(
    mail => codeMatchOf(mail) !== null || matchesOfKind(mail, 'confirm').length > 0,
  ))
}

/**
 * 一封邮件的列表第二行。
 *
 * 优先给「用户现在要做什么」：
 *   验证码 → 验证码；确认 → 按钮文案；自定义 → 类型名 + 文本首行；总结 → minimal。
 */
export function mailSummaryLine(mail: Mail): string {
  const code = codeMatchOf(mail)
  if (code)
    return `${t('mail.code')}：${code.code}`

  const confirm = matchesOfKind(mail, 'confirm')[0]
  if (confirm)
    return confirm.label || t('mail.confirm')

  const custom = matchesOfKind(mail, 'custom')[0]
  if (custom) {
    const firstLine = custom.text.split('\n')[0]?.trim() ?? ''
    return [custom.adapterName, firstLine].filter(Boolean).join('：')
  }

  const summary = summaryMatchOf(mail)
  if (summary?.minimal)
    return summary.minimal
  if (summary?.text)
    return summary.text.split('\n')[0] ?? ''

  return mail.snippet
}

/** 「这封邮件是降级的吗」——UI 上给 ⚠️ 角标 */
export function isDegraded(mail: Mail): boolean {
  return mail.ai?.degraded === true
}

/** 兼容旧调用点（badge 仍由 `logic/types` 算） */
export { badgeCount }
