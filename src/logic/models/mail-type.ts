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

export interface MailTypeMatchBase {
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
  /**
   * 适配器自己的参数（可选，按 adapter 解释）。
   *
   * 目前只有内置「验证码」用 `autoCopyCode`；自定义类型不展示参数，但字段保留，
   * 以后加参数不用再改存储形状。
   */
  params?: Record<string, unknown>
}

/** IDB `mailTypes` 的持久化记录（内置只存 override，自定义整条存） */
export interface MailTypeRecord {
  id: string
  kind: 'builtin' | 'custom'
  enabled?: boolean
  /** 内置 override */
  userPrompt?: string
  /** 适配器自己的参数（见 `MailTypeAdapter.params`） */
  params?: Record<string, unknown>
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
  params: true,
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
