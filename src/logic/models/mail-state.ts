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
