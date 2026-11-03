/**
 * AI 输出的 zod schema、类型命中的二次校验、降级策略。
 *
 * 设计文档的原则（`design/ai-prompt-design.md § 1`）：**AI 永远返回固定 schema 的
 * JSON；失败 = zod 校验失败 → 重试 1 次 → 降级**。这里是那条链路的最后一环。
 *
 * ⚠ 模型不可信：zod 只挡结构性错误，真正的业务校验在 `resolveAiTypes`：
 *   - 未启用 / 不存在 / 重复的 adapterId 丢掉；
 *   - 验证码走 `cleanCode`；URL 只留 http/https；
 *   - 有效期换算 + 合理性检查；
 *   - 兜底规则（有非兜底命中就丢掉所有兜底；多个兜底只留优先级最高的一个）。
 */

/** 验证码：只保留 `[A-Za-z0-9]{4,12}`，与提示词的承诺一致 */
export const CODE_PATTERN = /^[A-Z0-9]{4,12}$/i

/**
 * 把模型给的 `code` 洗成可用的验证码，或丢成 `null`。
 *
 * 三个真实会遇到的形态都要处理：
 *   1. `"您的验证码是 123456"` —— 提示词明确要求只要字母数字，但模型经常手滑
 *   2. `"123 456"` —— 邮件里为了可读性加了空格
 *   3. `"null"` / `"none"` / `""` —— 模型把「没有验证码」写成了字符串
 *
 * ⚠ 第 3 种最危险：把它当验证码复制进剪贴板，用户会得到一个 "null"。
 */
export function cleanCode(value: string | null | undefined): string | null {
  if (typeof value !== 'string')
    return null

  const trimmed = value.trim()
  if (!trimmed)
    return null

  const lowered = trimmed.toLowerCase()
  if (['null', 'none', 'nil', 'n/a', 'na', '无', '没有', 'false', 'undefined'].includes(lowered))
    return null

  // 1. 整体就是一个验证码（最常见、也最可信的形态）
  if (CODE_PATTERN.test(trimmed))
    return trimmed

  /*
   * 2. 被空格 / 连字符分组的纯数字：`123 456`、`123-456`。
   *
   * ⚠ 只在「去掉分组符之后整个串就是纯数字」时才接受。
   *   用「把所有空白删掉再看」是不行的：`code 123456` 会变成 `code123456` ——
   *   一个 10 位的字母数字串，正好符合 `[A-Za-z0-9]{4,12}`。
   */
  const digitsOnly = trimmed.replace(/[\s-]/g, '')
  if (/^\d{4,12}$/.test(digitsOnly))
    return digitsOnly

  // 3. 从文本里抽第一个含数字的 4-12 位字母数字串
  const tokens = trimmed.match(/\b[A-Z0-9]{4,12}\b/gi)
  if (!tokens?.length)
    return null

  const withDigit = tokens.find(token => /\d/.test(token))
  return withDigit ?? null
}
