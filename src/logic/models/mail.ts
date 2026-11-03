import type { MailStateFlags } from './mail-state'
import type { AiOutput, CodeMatch, MailTypeMatch, SummaryMatch } from './mail-type'
import { nanoid } from 'nanoid'
import { BUILTIN_CODE_ID, BUILTIN_SUMMARY_ID } from './mail-type'
// ---------------------------------------------------------------------------
// Mail
// ---------------------------------------------------------------------------

export interface MailAddress {
  name: string
  address: string
}

export type MailProcessing = 'pending' | 'sent' | 'skipped'

export type CopyStatus = 'none' | 'copied' | 'failed'

export interface Mail {
  /** = `<accountId>:<messageId>`（外部键），messageId 缺失时退化为 nanoid */
  id: string
  accountId: string

  // 头部
  from: MailAddress[]
  to: MailAddress[]
  cc?: MailAddress[]
  subject: string

  // 内容
  /** text 前 240 字 */
  snippet: string
  /** 全文（截断 50k 字内）；极简模式**不存 */
  bodyText?: string
  /** ⚠ MVP 不存 HTML（隐私 + 体积） */
  bodyHtml?: string

  // 时间
  receivedAt: number

  // 状态
  processing: MailProcessing
  ai?: AiOutput
  copyStatus: CopyStatus
  read: boolean
  /** 用户标记不再显示 */
  dismissed?: boolean

  /**
   * 邮件内部状态标签（位掩码，见 `MailStateFlag`）。
   *
   * ⚠ 从 Feature 08 起，`isAd` / `urgency` 不再放在 `ai` 里 —— 它们不属于
   *   任何「类型」，而是邮件自身的状态。`ad + urgent` 可以同时成立。
   */
  stateFlags: MailStateFlags

  /**
   * 从 HTML `href` 与正文裸链接里抽到的 URL（≤10，仅 http/https）。
   *
   * 为什么单独存：`htmlToText` 只保留 `<a>` 的文字、丢掉 `href`，只有 HTML 部分的
   * 确认邮件因此拿不到链接。存下来之后 AI prompt 与确认按钮都能用。
   * ⚠ 链接里可能带一次性 token：只存本地、不写日志。
   */
  links?: string[]

  /**
   * 进入回收站的时刻（`Date.now()`）。
   *
   * ## 为什么不是布尔量 `trashed: true`
   *
   * 回收站要**按删除时间排序**（最近删的在最上面），而且要能在列表里显示
   * 「什么时候删的」。布尔量表达不了这两个需求，而时间戳可以 ——
   * 判据仍然是便宜的 `!!mail.trashedAt`。
   *
   * ## 语义：这是**状态变更**，不是软删除
   *
   * 移入回收站只是把邮件换个列表放着，记录本身**不动**（正文、AI 结果都还在），
   * 所以「恢复」是零成本的。只有「彻底删除」才真的从仓库里移除记录。
   *
   * 见 `logic/store/mails.ts` 的 `trashMail` / `purgeMails`。
   */
  trashedAt?: number

  /**
   * 极简模式提取到的验证码（顶层冗余字段）。
   *
   * ⚠ 与 `ai.code` 并存是**有意的冗余**，不是设计疏漏：
   *   极简模式下 `ai` 只填了 `code` 一项（其余都是空），而 UI 的「验证码」分区与
   *   badge 计数需要一条**便宜的**判据 —— `!!mail.code` 比 `!!mail.ai?.code` 少一层
   *   可选链，更重要的是它让「这条记录的用途就是验证码」在类型上显式可见。
   *   完整模式**不写**这个字段（只写 `ai.code`），避免两份真相互相同步。
   */
  code?: string | null

  /**
   * 验证码失效的**绝对时刻**（时间戳）。
   *
   * ⚠ 存下来而不是每次现算（`receivedAt + ai.validForSeconds`）：它要在 UI 上
   *   每秒被读一次做倒计时，而现算要两跳可选链；更要紧的是**存下来才能被
   *   「重新计算」钳制**（见 `logic/ai/pipeline.ts` 的 `reconcileCodeExpiry`）——
   *   否则补拉一封三天前的验证码邮件，界面会显示「还有 5 分钟」。
   *
   * 只有「正文里明确写了有效期」时才有值。没有就**不写**这个字段，
   * UI 也就不展示倒计时。
   */
  codeExpiresAt?: number

  /**
   * 验证码的**总有效期秒数**（与 `codeExpiresAt` 同时写入）。
   *
   * ⚠ 它存在的唯一理由是**进度条的分母**。
   *
   *   只靠 `codeExpiresAt` 前端算不出「现在走到百分之几了」——
   *   那需要知道起点。而起点（入库时刻）没有单独存，
   *   所以组件曾用「挂载那一刻的剩余量」当分母 ——
   *   结果是**每次打开 Popup 进度条都从 100% 重新往下走**，
   *   完全不能反映真实剩余比例。
   *
   *   存下总时长之后：`已过比例 = 1 - 剩余 / 总时长`，
   *   这个值只由「现在」决定，与什么时候打开 Popup 无关。
   */
  codeValidForSeconds?: number

  // 原始（可丢弃）
  messageId?: string
  listUnsubscribe?: string
  /** 命中的规则 id（调试 / 跳转） */
  ruleId?: string
}

/** `Mail` 的字段白名单 */
export const MAIL_FIELDS: Record<keyof Mail, true> = {
  id: true,
  accountId: true,
  from: true,
  to: true,
  cc: true,
  subject: true,
  snippet: true,
  bodyText: true,
  bodyHtml: true,
  receivedAt: true,
  processing: true,
  ai: true,
  copyStatus: true,
  read: true,
  dismissed: true,
  stateFlags: true,
  links: true,
  trashedAt: true,
  code: true,
  codeExpiresAt: true,
  codeValidForSeconds: true,
  messageId: true,
  listUnsubscribe: true,
  ruleId: true,
}

/**
 * 邮件的账本键：`<accountId>:<messageId>`。
 *
 * 单独抽成函数而不是各处拼字符串：键的拼法一旦在两处不一致，症状是
 * 「同步成功了但同一个邮件反复入库」——很难联想到是键写歪了。
 */
export function mailKey(accountId: string, messageId: string): string {
  return `${accountId}:${messageId}`
}

// ---------------------------------------------------------------------------
// 类型命中的便捷读取（UI / 筛选共用）
// ---------------------------------------------------------------------------

/** 命中的类型（没有就是空数组） */
export function mailTypeMatches(mail: Pick<Mail, 'ai'>): MailTypeMatch[] {
  return mail.ai?.types ?? []
}

/** 是否命中某个适配器 */
export function hasMailType(mail: Pick<Mail, 'ai'>, adapterId: string): boolean {
  return mailTypeMatches(mail).some(match => match.adapterId === adapterId)
}

/** 某个 kind 的全部命中（按存储顺序 = 优先级顺序） */
export function matchesOfKind<K extends MailTypeMatch['kind']>(
  mail: Pick<Mail, 'ai'>,
  kind: K,
): Extract<MailTypeMatch, { kind: K }>[] {
  return mailTypeMatches(mail).filter(
    (match): match is Extract<MailTypeMatch, { kind: K }> => match.kind === kind,
  )
}

/**
 * 验证码命中（含**老数据兜底**）。
 *
 * ⚠ 老邮件没有 `ai.types`，只有顶层 `code` / `ai.code`。直接读 `matchesOfKind`
 *   会让它们在升级后突然「没有验证码」—— 复制按钮、badge、筛选全失效。
 *   这里把老字段合成一个 match，UI 不需要到处写兼容分支。
 */
export function codeMatchOf(mail: Pick<Mail, 'code' | 'ai' | 'codeExpiresAt' | 'codeValidForSeconds'>): CodeMatch | null {
  const existing = mailTypeMatches(mail).find((match): match is CodeMatch => match.kind === 'code')
  if (existing) {
    // 新数据 match 里自带 expiry；老数据 / 测试可能只有顶层字段，补进去
    if (existing.expiry)
      return existing
    const fallbackExpiry = mail.codeExpiresAt && mail.codeValidForSeconds
      ? { at: mail.codeExpiresAt, totalSeconds: mail.codeValidForSeconds }
      : undefined
    return fallbackExpiry ? { ...existing, expiry: fallbackExpiry } : existing
  }

  const code = mail.code ?? mail.ai?.code
  if (!code)
    return null

  const expiry = mail.codeExpiresAt && mail.codeValidForSeconds
    ? { at: mail.codeExpiresAt, totalSeconds: mail.codeValidForSeconds }
    : undefined

  return {
    kind: 'code',
    adapterId: BUILTIN_CODE_ID,
    // 老数据没有存名字；UI 会用 i18n 的默认名兜底
    adapterName: '',
    code,
    expiry,
  }
}

/** 总结命中（含老数据兜底：`ai.summary` / `ai.minimal`） */
export function summaryMatchOf(mail: Pick<Mail, 'ai'>): SummaryMatch | null {
  const existing = mailTypeMatches(mail).find((match): match is SummaryMatch => match.kind === 'summary')
  if (existing)
    return existing

  const summary = mail.ai?.summary
  const minimal = mail.ai?.minimal
  if (!summary && !minimal)
    return null

  return {
    kind: 'summary',
    adapterId: BUILTIN_SUMMARY_ID,
    adapterName: '',
    minimal: minimal ?? '',
    text: summary ?? '',
  }
}

/**
 * 这封邮件有没有「需要用户动作」的类型（验证码 / 确认）。
 *
 * 用途：「重要」筛选里的特例 —— 验证码 / 确认邮件即使被 AI 标了 low，
 * 也必须留在重要里（用户正等着它）。
 */
export function hasActionableType(mail: Pick<Mail, 'code' | 'ai' | 'codeExpiresAt' | 'codeValidForSeconds'>): boolean {
  return codeMatchOf(mail) !== null || matchesOfKind(mail, 'confirm').length > 0
}

/** 从键反解 `accountId`（`by-accountId` 索引够用，这里只服务兜底路径） */
export function accountIdOfMailKey(key: string): string {
  const at = key.indexOf(':')
  return at === -1 ? key : key.slice(0, at)
}

/** server 没给 messageId 时的兜底标识 */
export function fallbackMessageId(): string {
  return nanoid()
}
