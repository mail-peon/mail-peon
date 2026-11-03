import type { Expiry, Mail } from '~/logic/types'
/** 验证码有效期的上下限（秒） */
export const MIN_VALID_FOR_SECONDS = 10

export const MAX_CODE_VALID_FOR_SECONDS = 24 * 60 * 60

/** 确认链接可以更长：7 天很常见，留到 30 天 */
export const MAX_CONFIRM_VALID_FOR_SECONDS = 30 * 24 * 60 * 60

/**
 * 解析 AI 给的时长（秒）。
 *
 * ⚠ 这不是「用代码去找时间」：它只处理 AI 输出的那个字段值，职责只有
 *   换算单位（`"5 分钟"` → `300`）与挡住明显错的（`0` / 负数 / `14:30`）。
 *   读信息是 AI 的事，格式与合理性是我们的事。
 *
 * ⚠ 歧义时一律返回 `null`，绝不猜。
 */
export function parseValidForSeconds(value: unknown): number | null {
  if (value === null || value === undefined)
    return null

  if (typeof value === 'number')
    return Number.isFinite(value) ? roundSeconds(value) : null

  if (typeof value !== 'string')
    return null

  const trimmed = value.trim().toLowerCase()
  if (!trimmed)
    return null

  if (['null', 'none', 'nil', 'n/a', 'na', '无', '没有', 'unknown', 'false', 'undefined'].includes(trimmed))
    return null

  // 形态 1：纯数字，或数字 + 「秒」这一族后缀
  const pureNumber = /^(\d+(?:\.\d+)?)\s*(?:(?!m|h)[a-z]+|秒)?$/.exec(trimmed)
  if (pureNumber)
    return roundSeconds(Number.parseFloat(pureNumber[1]))

  // 形态 2：`5 分钟` / `5min` / `2 小时` / `2h` / `7 天` / `7d`
  const withUnit = /^(\d+(?:\.\d+)?)\s*(分钟|小时|[分时天日]|[dhm][a-z]*)$/.exec(trimmed)
  if (withUnit) {
    const amount = Number.parseFloat(withUnit[1])
    const marker = withUnit[2]
    const isHour = marker.startsWith('h') || marker === '小时' || marker === '时'
    const isDay = marker.startsWith('d') || marker === '天' || marker === '日'
    const multiplier = isDay ? 86_400 : (isHour ? 3600 : 60)
    return roundSeconds(amount * multiplier)
  }

  return null
}

export function roundSeconds(seconds: number): number | null {
  if (!Number.isFinite(seconds) || seconds < MIN_VALID_FOR_SECONDS)
    return null
  return Math.round(seconds)
}

/**
 * 验证码时长（上限 24h）。
 *
 * 上限理由：把「7 天内发货」当成验证码有效期，界面上会出现一个 7 天的倒计时。
 * 确认链接用 `MAX_CONFIRM_VALID_FOR_SECONDS`，见 `resolveExpiry`。
 */
export function cleanValidForSeconds(value: unknown): number | null {
  const seconds = parseValidForSeconds(value)
  if (seconds === null || seconds > MAX_CODE_VALID_FOR_SECONDS)
    return null
  return seconds
}

/**
 * 解析绝对失效时间。
 *
 * 允许三种输入：
 *   - ISO 字符串 / `Date.parse` 能读的字符串；
 *   - epoch 毫秒（> 1e12）；
 *   - epoch 秒（<= 1e12，很多链接里是秒级时间戳）。
 *
 * 解析不出 / 非正数 → `null`（不猜）。
 */
export function parseAbsoluteTime(value: unknown): number | null {
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || value <= 0)
      return null
    return value > 1e12 ? Math.round(value) : Math.round(value * 1000)
  }

  if (typeof value !== 'string')
    return null

  const trimmed = value.trim()
  if (!trimmed)
    return null

  if (/^\d+$/.test(trimmed)) {
    const n = Number.parseInt(trimmed, 10)
    if (!Number.isFinite(n) || n <= 0)
      return null
    return n > 1e12 ? n : n * 1000
  }

  const parsed = Date.parse(trimmed)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null
}

/**
 * 把「时长 / 绝对时间」统一成 `Expiry`（绝对时刻 + 进度条分母）。
 *
 * @param mail 邮件（用 `receivedAt` 当相对时长的基准）
 * @param raw AI 抽到的字段
 * @param raw.validForSeconds 相对时长（秒 / 可读单位）
 * @param raw.expiresAt 绝对失效时间（ISO / epoch）
 * @param maxSeconds 该类型的上限（验证码 24h / 确认 30d）
 */
export function resolveExpiry(
  mail: Pick<Mail, 'receivedAt'>,
  raw: { validForSeconds?: unknown, expiresAt?: unknown },
  maxSeconds: number,
): Expiry | undefined {
  const seconds = parseValidForSeconds(raw.validForSeconds)
  const capped = seconds === null ? null : Math.min(seconds, maxSeconds)
  const explicitAt = parseAbsoluteTime(raw.expiresAt)

  if (explicitAt !== null) {
    /*
     * 绝对时间必须落在「收信时间附近」才可信：
     *   - 太远未来（超过该类型上限）→ 多半是模型把别的日期当成了失效时间；
     *   - 太远过去（早于 7 天）→ 垃圾数据 / 解析错。
     * 保留 7 天回看，是因为补拉的旧邮件里链接可能刚好过期。
     */
    if (explicitAt > mail.receivedAt + maxSeconds * 1000)
      return undefined
    if (explicitAt < mail.receivedAt - 7 * 24 * 60 * 60 * 1000)
      return undefined

    const derivedTotal = Math.max(1, Math.round((explicitAt - mail.receivedAt) / 1000))
    return {
      at: explicitAt,
      totalSeconds: capped ?? Math.min(derivedTotal, maxSeconds),
    }
  }

  if (capped === null)
    return undefined

  // 与验证码原有逻辑一致：基准取 min(receivedAt, now)，避免未来时间导致虚高
  const base = Math.min(mail.receivedAt, Date.now())
  return { at: base + capped * 1000, totalSeconds: capped }
}
