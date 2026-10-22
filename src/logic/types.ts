import { nanoid } from 'nanoid'

/**
 * 全局领域模型。background / popup / options / sidepanel / content-script 五方共享，
 * 因此这里不引入任何运行时依赖（除了 `nanoid` 这种纯函数），只放类型、常量与默认值。
 *
 * 字段定义与 `ai-docs/design/data-model.md` 一一对应 —— **改这里之前先改文档**。
 */

// ---------------------------------------------------------------------------
// 账号
// ---------------------------------------------------------------------------

/**
 * 邮箱协议标识。
 *
 * 与 offer-hunter 的 `SiteId` 一样是**开放字符串**：provider 是按目录约定自动索引的
 * （`src/adapters/mail/providers/<id>/index.ts`），闭合联合会逼着「加一家 provider
 * 还要改领域模型」。代价是拼错 id 编译器不再拦，改由 `createMailProvider` 在未知
 * id 上抛错 + 注册表单测兜底。
 */
export type MailProviderId = string

/**
 * provider 的「增量游标」。
 *
 * ⚠ 这是对设计文档的一处**必要推广**：文档把游标写死成 IMAP 的 `lastSeenUid`
 *   （数字 UID），但 Gmail API 的增量游标是 `historyId`（字符串），且没有
 *   `UIDVALIDITY` 这种东西。若把 `lastSeenUid` 硬编码进同步编排，加第二个
 *   provider 就要改 `syncAccount` —— 那正是适配器层要消掉的耦合。
 *
 * 形状：`{ ...provider 私有字段 }`。IMAP 放 `{ uid, uidValidity }`，
 *   Gmail 放 `{ historyId }`。**只有对应 provider 自己读得懂**，编排层只负责透传。
 *   `null` = 从未同步过（首次 sync 只记游标，不拉任何历史邮件）。
 */
export type SyncCursor = Record<string, unknown> | null

/**
 * 账号凭据。
 *
 * ⚠ MVP 明文存 IndexedDB（见 `decisions/open-questions.md` Q2）：不存在
 *   「既方便又安全」的密钥来源。Options 里有隐私声明与「清空所有数据」按钮。
 */
export interface ProviderConfig {
  // --- IMAP（需要 WebSocket↔TCP 中继，见 decisions/adr-0005）---
  host?: string
  /** 993 */
  port?: number
  /** true */
  tls?: boolean
  user?: string
  pass?: string
  /** IMAP 中继地址（`wss://…`）；留空表示该 provider 在当前环境不可用 */
  relayUrl?: string

  // --- Gmail API ---
  /** Google OAuth Client ID（`*.apps.googleusercontent.com`） */
  clientId?: string
  /** OAuth 授权码换来的 refresh token */
  refreshToken?: string
  /** 访问令牌 */
  accessToken?: string
  /** 访问令牌过期时刻（ts） */
  expiresAt?: number

  // --- Outlook Graph（M3+ 预留）---
  tenantId?: string
}

export type BlockedEntry
  = | { kind: 'email', value: string }
    | { kind: 'domain', value: string }

export interface MailAccount {
  /** = accountId（外部键） */
  id: string
  label: string
  /** 邮箱地址；`by-email` 索引按它查 */
  email: string
  /** 协议 id，必须等于 `adapters/mail/providers/<id>/` 的目录名 */
  provider: MailProviderId
  config: ProviderConfig
  /** per-account 排除邮箱（详见 features/06-blocked-senders.md） */
  blockedList: BlockedEntry[]
  enabled: boolean
  createdAt: number
  lastSyncedAt?: number
  lastError?: string

  /** 增量同步游标；`null` = 从未同步过（首次 sync 只记这个，不拉历史） */
  cursor?: SyncCursor
}

/**
 * 兼容字段：设计文档里的 `lastSeenUid` / `uidValidity`。
 *
 * 读的时候从 `cursor` 里取（见 `readMailCursor`）；写的时候由 IMAP provider 自己
 * 塞进 `cursor`。**不再是 `MailAccount` 的顶层字段** —— 理由见 `SyncCursor`。
 */
export interface ImapCursor {
  uid: number
  uidValidity?: number | null
}

export interface GmailCursor {
  historyId: string
}

/** `MailAccount` 的字段白名单（运行时归一化用；增删字段必须同步改这里，否则编译不过） */
export const MAIL_ACCOUNT_FIELDS: Record<keyof MailAccount, true> = {
  id: true,
  label: true,
  email: true,
  provider: true,
  config: true,
  blockedList: true,
  enabled: true,
  createdAt: true,
  lastSyncedAt: true,
  lastError: true,
  cursor: true,
}

// ---------------------------------------------------------------------------
// PromptRule
// ---------------------------------------------------------------------------

export type Matcher
  = | { kind: 'email', value: string }
    | { kind: 'domain', value: string }
    | { kind: 'regex', value: string }

export interface PromptRule {
  /** = ruleId（外部键） */
  id: string
  name: string
  enabled: boolean
  /** 用户拖拽 = 改 priority；**数字越小越优先 */
  priority: number
  /** 多匹配（任一命中即匹配） */
  matchers: Matcher[]
  prompt: string
  /** 不论全局开关，本规则强制自动复制验证码 */
  alwaysCopyCode?: boolean
  /** 本规则始终认为不是广告（覆盖 AI 的 isAd） */
  alwaysSkipAd?: boolean
  createdAt: number
  updatedAt: number
}

/** `PromptRule` 的字段白名单 */
export const PROMPT_RULE_FIELDS: Record<keyof PromptRule, true> = {
  id: true,
  name: true,
  enabled: true,
  priority: true,
  matchers: true,
  prompt: true,
  alwaysCopyCode: true,
  alwaysSkipAd: true,
  createdAt: true,
  updatedAt: true,
}

/**
 * 内置「全局默认规则」。
 *
 * 用户不需要自己建一条来兜底 —— 没有任何规则命中时用它（见 `logic/rules/matcher.ts`）。
 * `id` 用固定串，便于 UI 上标注「内置」并禁止删除。
 */
export const DEFAULT_RULE_ID = '__default__'

export function createDefaultRule(): PromptRule {
  return {
    id: DEFAULT_RULE_ID,
    name: '默认规则（内置）',
    enabled: true,
    priority: Number.MAX_SAFE_INTEGER,
    matchers: [],
    prompt: '',
    createdAt: 0,
    updatedAt: 0,
  }
}

// ---------------------------------------------------------------------------
// AI 输出
// ---------------------------------------------------------------------------

export type Urgency = 'low' | 'normal' | 'high'

/**
 * 邮件内部状态标签（**位掩码**）。
 *
 * 这些是「邮件本身是什么」的标签，和用户可见的**类型**（验证码 / 确认 / 自定义）
 * 是两回事：一封验证码邮件可以同时是 `Ad`，一封营销邮件也可以同时是 `LowPriority`。
 *
 * 用位运算而不是多个布尔字段：一个数字能表达多个标签，存储与筛选都便宜
 * （`flags & Ad` 一次判断），加新状态只是加一个 bit。
 */
export const MailStateFlag = {
  None: 0,
  /** 营销 / 推广 / 自动通知（原 `AiOutput.isAd`） */
  Ad: 1 << 0,
  /** 需要立刻处理（原 `urgency = 'high'`） */
  Urgent: 1 << 1,
  /** 低优先级（原 `urgency = 'low'`）；与 `Urgent` 互斥 */
  LowPriority: 1 << 2,
} as const

export type MailStateFlags = number

/** 已知位的掩码：归一化时把未来 / 垃圾位清掉 */
export const MAIL_STATE_ALL
  = MailStateFlag.Ad | MailStateFlag.Urgent | MailStateFlag.LowPriority

/** 是否包含某个状态位 */
export function hasMailState(flags: number | undefined, flag: number): boolean {
  return ((flags ?? 0) & flag) !== 0
}

/**
 * 归一化位掩码。
 *
 * ⚠ `Urgent` 与 `LowPriority` 同时出现是非法状态（模型 / 老数据 / 手改都可能）。
 *   保留 `Urgent`、丢掉 `LowPriority`：宁可让用户多看一眼，也不要让紧急邮件被静音。
 */
export function normalizeMailStateFlags(value: unknown): MailStateFlags {
  const raw = typeof value === 'number' && Number.isFinite(value) ? value : 0
  let flags = raw & MAIL_STATE_ALL
  if (flags & MailStateFlag.Urgent)
    flags &= ~MailStateFlag.LowPriority
  return flags
}

/** 老数据迁移：`ai.isAd` / `ai.urgency` → 位掩码 */
export function mailStateFlagsFromLegacy(
  isAd: unknown,
  urgency: unknown,
): MailStateFlags {
  let flags = 0
  if (isAd === true)
    flags |= MailStateFlag.Ad
  if (urgency === 'high')
    flags |= MailStateFlag.Urgent
  if (urgency === 'low')
    flags |= MailStateFlag.LowPriority
  return normalizeMailStateFlags(flags)
}

/** AI 输出的状态字符串 → 位掩码（模型只给语义，位运算由 JS 做） */
export function mailStateFlagsFromStates(states: readonly string[] | undefined): MailStateFlags {
  let flags = 0
  for (const state of states ?? []) {
    if (state === 'ad')
      flags |= MailStateFlag.Ad
    else if (state === 'urgent')
      flags |= MailStateFlag.Urgent
    else if (state === 'low')
      flags |= MailStateFlag.LowPriority
  }
  return normalizeMailStateFlags(flags)
}

// ---------------------------------------------------------------------------
// 邮件类型适配器（Feature 08）
// ---------------------------------------------------------------------------

/** 内置适配器 id（固定串：UI / prompt / 历史数据都靠它） */
export const BUILTIN_CODE_ID = 'builtin:code'
export const BUILTIN_CONFIRM_ID = 'builtin:confirm'
export const BUILTIN_SUMMARY_ID = 'builtin:summary'

export type BuiltinMailTypeId
  = typeof BUILTIN_CODE_ID
    | typeof BUILTIN_CONFIRM_ID
    | typeof BUILTIN_SUMMARY_ID

/** 内置类型的专属 UI；`null` = 自定义类型（只有一段文本） */
export type MailTypeUi = 'code' | 'confirm' | 'summary' | null

/** 失效信息：绝对时刻 + 进度条分母 */
export interface Expiry {
  /** 绝对失效时刻（epoch ms） */
  at: number
  /** 总有效期秒数（进度条分母） */
  totalSeconds: number
}

interface MailTypeMatchBase {
  adapterId: string
  /** 冗余存储：适配器被改名 / 删除后，历史邮件仍能显示当时的名字 */
  adapterName: string
}

export interface CodeMatch extends MailTypeMatchBase {
  kind: 'code'
  code: string
  expiry?: Expiry
}

export interface ConfirmMatch extends MailTypeMatchBase {
  kind: 'confirm'
  url: string
  /** URL 的 host（UI 显示目标域名用；冗余存储避免每次解析） */
  host: string
  label?: string
  expiry?: Expiry
}

export interface SummaryMatch extends MailTypeMatchBase {
  kind: 'summary'
  minimal: string
  text: string
}

export interface CustomMatch extends MailTypeMatchBase {
  kind: 'custom'
  text: string
}

export type MailTypeMatch = CodeMatch | ConfirmMatch | SummaryMatch | CustomMatch

/** 运行时视图：内置 catalog + 用户 override 合并后的适配器 */
export interface MailTypeAdapter {
  id: string
  kind: 'builtin' | 'custom'
  ui: MailTypeUi
  name: string
  description: string
  enabled: boolean
  /** 越小越靠前 */
  priority: number
  /** true = 仅当没有任何非兜底类型命中时才输出 */
  fallback: boolean
  prompt: string
  /** 内置类型的用户补充规则 */
  userPrompt?: string
}

/** IDB `mailTypes` 的持久化记录（内置只存 override，自定义整条存） */
export interface MailTypeRecord {
  id: string
  kind: 'builtin' | 'custom'
  enabled?: boolean
  /** 内置 override */
  userPrompt?: string
  /** 自定义 */
  name?: string
  prompt?: string
  priority?: number
  fallback?: boolean
  createdAt: number
  updatedAt: number
}

/** `MailTypeRecord` 的字段白名单 */
export const MAIL_TYPE_RECORD_FIELDS: Record<keyof MailTypeRecord, true> = {
  id: true,
  kind: true,
  enabled: true,
  userPrompt: true,
  name: true,
  prompt: true,
  priority: true,
  fallback: true,
  createdAt: true,
  updatedAt: true,
}

export interface AiOutput {
  /** 命中的类型（已按优先级排序、已应用兜底）—— 唯一真相 */
  types: MailTypeMatch[]
  /**
   * 兼容旧 UI 的派生字段。
   *
   * ⚠ 新邮件由 pipeline 从 `types` 派生；老数据没有 `types` 时由归一化合成。
   *   新代码尽量直接用 `types` / 下面那些 helper，不要继续扩散这些字段。
   */
  minimal?: string
  summary?: string
  code?: string | null
  /**
   * 验证码的**有效期秒数**（AI 从正文里读到的）。
   *
   * ⚠ 刻意让 AI 输出**相对秒数**而不是绝对时间。理由有两条：
   *
   *   1. 模型看不到当前时间，让它算 `expiresAt` 等于让它瞎猜；
   *   2. 邮件里的表述本来就是相对的，而且**从发信时刻起算**。
   *      换算成绝对时间是我们的事，不是它的事。
   *
   * `null` = 邮件里**没有明确**写有效期。
   */
  validForSeconds?: number | null
  /** AI 失败走降级时为 true */
  degraded?: boolean
  /** 降级原因 */
  error?: string
}

/**
 * AI 调用错误分类（`ai-docs/design/ai-prompt-design.md § 8`）。
 *
 * 「可诊断」是这里存在的全部意义：UI 上要能告诉用户是 key 错了、网络不通、
 * 还是模型没按 schema 回 —— 而不是笼统的「AI 失败」。
 */
export type AiErrorKind = 'network' | 'http' | 'schema' | 'timeout' | 'rate-limit' | 'unknown'

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

// ---------------------------------------------------------------------------
// 跨上下文消息体（消息名与签名在 shim.d.ts 的 ProtocolMap 里）
// ---------------------------------------------------------------------------

/**
 * 一轮同步的结果摘要（`accounts:sync-now` 的返回值）。
 *
 * 放在领域模型里而不是 `shim.d.ts`：`.d.ts` 里只有类型声明，运行时拿不到它，
 * 而 Options 的「立即同步」要遍历这个数组渲染结果。
 */
export interface SyncSummary {
  accountId: string
  label: string
  /** 是否只是记了游标（首次同步不拉历史） */
  firstSync: boolean
  fetched: number
  /** 被排除邮箱挡掉的封数 */
  blocked: number
  /** 解析 / 处理失败的封数 */
  failed: number
  warning?: string
}

/** AI 连通性测试结果 */
export interface AiTestResult {
  ok: boolean
  detail?: string
  error?: string
  latencyMs?: number
}

/** 邮箱连通性测试结果 */
export interface MailTestResult {
  ok: boolean
  detail?: string
  error?: string
}

// ---------------------------------------------------------------------------
// 设置
// ---------------------------------------------------------------------------

/**
 * IDB 内邮件保留份数；滚动淘汰。`'unlimited'` = 不淘汰。
 *
 * ⚠ 极简模式**写死** `MINIMAL_RETENTION`（50 条验证码），不读这个值。
 */
export type MailRetention = 100 | 200 | 500 | 1000 | 'unlimited'

/**
 * 写入邮件时能接受的实际上限。
 *
 * 比 `MailRetention` 宽一档，多出极简模式那个写死的 `MINIMAL_RETENTION = 50`
 * （它不在用户可选的档位里，所以不能塞进 `MailRetention` 的联合类型 —— 那会让
 * 「用户可选 50」在类型上变成合法的，而设置页里根本没有这一项）。
 */
export type RetentionLimit = MailRetention | typeof MINIMAL_RETENTION

export const MAIL_RETENTION_OPTIONS: readonly MailRetention[] = [100, 200, 500, 1000, 'unlimited'] as const

/** 极简模式写死的保留份数（`design/minimal-mode.md § 3.5`） */
export const MINIMAL_RETENTION = 50

/**
 * 列表筛选 id。
 *
 * - `important` / `all` / `ad`：**状态**筛选（重要是派生条件，ad 是 `MailStateFlag.Ad`）
 * - `adapter:<adapterId>`：筛出命中某个适配器的邮件（内置 + 自定义）
 *
 * ⚠ 从 Feature 08 起不再硬编码四个 tab —— 自定义适配器会动态变成筛选标签。
 */
export type MailFilterId = 'all' | 'important' | 'ad' | `adapter:${string}`

/** @deprecated 用 `MailFilterId`（保留别名是为了平滑迁移旧调用点） */
export type PopupTab = MailFilterId

export interface AppSettings {
  /** 两套运行模式：极简（固定验证码 + 确认） / 自定义（用户配置适配器） */
  minimalMode: boolean
  /** 仅自定义模式生效 */
  excludeAds: boolean
  /** 极简模式强制为 true */
  autoCopyCode: boolean
  /** 仅自定义模式生效 */
  blockedEnabled: boolean
  /** master switch；关掉后不动 badge */
  notifyOnNew: boolean
  /** 仅自定义模式生效；值见 `MailFilterId` */
  popupDefaultTab: MailFilterId
  mailRetention: MailRetention
  /** M3+：默认 0 = 不按时间清理 */
  mailRetentionDays: number

  /**
   * 验证码失效后自动删除（默认**开启**）。
   *
   * 行为：邮件的验证码到了「失效时刻」**再等 30 秒**，就自动移入回收站。
   *
   * ⚠ 为什么不是「立刻删」而是「等 30 秒」：
   *   失效时刻是由 AI 读到的时长 + 入库时刻推算的，本身有几十秒的误差
   *   （投递延迟、模型对「5 分钟」这类表述的取整）。立刻删会在边界上误删
   *   **其实还有效**的验证码 —— 而验证码是一次性的，误删等于用户要重新申请一个。
   *   30 秒宽限期把这类误差盖住，代价只是回收站里多躺半分钟。
   *
   * ⚠ 删的是**进回收站**，不是硬删除 —— 详见 `Mail.trashedAt` 的说明。
   */
  autoDeleteExpiredCode: boolean

  schemaVersion: number
}

export function createDefaultAppSettings(): AppSettings {
  return {
    minimalMode: true,
    excludeAds: true,
    autoCopyCode: true,
    blockedEnabled: true,
    notifyOnNew: true,
    popupDefaultTab: 'important',
    mailRetention: 100,
    mailRetentionDays: 0,
    autoDeleteExpiredCode: true,
    schemaVersion: 1,
  }
}

export type AiPlatformName = string

export type OutputLanguage = 'auto-browser' | 'auto-email'

export interface AiSettings {
  platform: AiPlatformName
  /** 留空时使用平台默认地址 */
  baseUrl?: string
  apiKey: string
  /** 留空时使用平台默认模型 */
  model?: string
  /** 默认 2048 */
  maxTokens?: number
  /** 默认 false（DeepSeek 等开思考会出事：token 被推理链吃光，content 为空） */
  thinking?: boolean
  outputLanguage: OutputLanguage
}

export function createDefaultAiSettings(): AiSettings {
  return {
    platform: 'deepseek',
    baseUrl: '',
    apiKey: '',
    model: '',
    maxTokens: 2048,
    thinking: false,
    outputLanguage: 'auto-browser',
  }
}

// ---------------------------------------------------------------------------
// 存储用量
// ---------------------------------------------------------------------------

export interface StorageUsage {
  count: number
  /** 估算字节数（UTF-16 长度 × 2）—— 不是真实占用，但数量级正确 */
  bytesApprox: number
  byAccount: Record<string, { count: number, bytesApprox: number }>
}

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

const URGENCY_RANK: Record<Urgency, number> = { high: 2, normal: 1, low: 0 }

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
