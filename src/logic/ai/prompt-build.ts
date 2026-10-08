import type { AiProvider } from '~/adapters/ai/types'
import type { AiSettings, Mail, PromptRule } from '~/logic/types'
import { formatSender } from '~/adapters/mail/parser'
import { DEFAULT_RULE_ID } from '~/logic/types'

/**
 * 提示词组装（**单一信源**：`ai-docs/design/ai-prompt-design.md`）。
 *
 * 三件事在这里定死，改动前请读完 `design/ai-prompt-design.md § 1` 的四条原则：
 *
 * 1. **结构强约束**：AI 永远返回固定 schema 的 JSON，失败 = zod 校验失败 → 重试 → 降级。
 * 2. **基础 system 不可被覆盖**：用户 PromptRule 只能**追加**场景化指令，
 *    不能改 JSON schema / `isAd` 的定义。所以规则提示词拼在基础 prompt **之后**，
 *    并被明确标注为「场景上下文」。
 * 3. **截断先行**：超大正文在调用前先截到 `MAX_BODY_CHARS`。
 * 4. **可观测**：每次调用记录 (mailId, model, latencyMs)。
 */

/**
 * 正文截断长度。
 *
 * 设计文档给的是 6000：中文约 2000 token，足够判断一封邮件的性质，
 * 又不会让长邮件（Newsletter、CI 日志）把上下文撑爆。
 *
 * ⚠ 刻意不做「按 token 估算」：估出来的 token 数与真实分词结果总有偏差
 *   （各家分词器不同），而基于错误估算的截断会让「刚好在边界上的邮件」
 *   时而完整时而截断 —— 那种不确定性比一刀切更难排查。
 */
export const MAX_BODY_CHARS = 6000

/** 用户提示词的长度上限（防止把系统提示词挤出上下文窗口） */
export const MAX_RULE_PROMPT_CHARS = 4000

/**
 * 中文基础 system prompt（`ai-prompt-design.md § 2.1`）。
 *
 * ⚠ 里面必须出现 "JSON" 字样：DeepSeek 要求 prompt 含该词才会启用 JSON 输出模式，
 *   否则可能返回一个空对象。这一点在 `buildSystemPrompt` 里有单测守着。
 */
export const ZH_SYSTEM_PROMPT = `你是 mail-peon 的邮件处理助手。任务是把一封邮件转成结构化 JSON。

# 输出 JSON Schema（不可省略任何字段）
{
  "minimal":  string,                  // ≤60 字中文，一行。用于列表与徽标。
  "summary":  string,                  // ≤600 字中文，结构化要点（可用 markdown）。
  "isAd":     boolean,                 // true 表示营销 / 推广 / 自动通知（订单状态、签到、Newsletter）。
  "code":     string | null,           // 邮件中的验证码 / OTP，仅字母数字，无"您的验证码是"等中文。
  "urgency":  "low" | "normal" | "high" // 用户需不需要立刻看到。
}

# 字段细则
- minimal：
  * 普通邮件：浓缩主旨 + 关键动作（动词），如"订单已发货，预计明天到"。
  * 广告邮件：留空字符串 ""。
  * 含验证码：仅写"验证码：XXXXXX"，其它不要。
- summary：
  * 2-4 段：主旨 / 关键信息 / 需要用户操作 / 链接（如有）。
- isAd：
  * true = 营销 / 促销 / 自动通知 / Newsletter / 订单状态提醒 / 平台推广 / 平台公告。
  * false = 真人邮件 / 重要系统通知（如登录告警、CI 失败、订阅内容交付）。
- code：
  * 仅当邮件含 OTP / 一次性链接 / 验证码时输出字符串；否则 null。
  * 仅保留 [A-Za-z0-9]{4,12}；超过或带中文视为 null。
- urgency：
  * high = 用户需要立即处理（登录告警、CI 失败、退款到账失败、面试）。
  * low = 营销 / 周报 / Newsletter。
  * 其它 = normal。

# 重要
- 仅返回 JSON，不要额外解释、不要 \`\`\` 围栏。
- 邮件正文可能含 HTML / 引言 / 多语言，忽略噪声部分。`

/**
 * 英文基础 system prompt（`ai-prompt-design.md § 2.2`）。
 *
 * 用在两种情况：浏览器语言不是中文（`auto-browser`），或用户选了 `auto-email`。
 * 设计文档刻意**只维护两套模板** —— 其它语言都走英文 + 一句自适应指令，
 * 因为「为每种语言维护一套完整提示词」是永远追不上的维护负担。
 */
export const EN_SYSTEM_PROMPT = `You are mail-peon's email-processing assistant. Convert an email into structured JSON.

# Output JSON Schema (no field may be omitted)
{
  "minimal":  string,                  // ≤60 chars, single line. Used by the list and badge.
  "summary":  string,                  // ≤600 chars, structured (markdown allowed).
  "isAd":     boolean,                 // true = marketing / promo / auto-notification (order status, check-in, newsletter).
  "code":     string | null,           // OTP / one-time code if present (alphanumeric only; no surrounding words).
  "urgency":  "low" | "normal" | "high" // whether the user must see this right now.
}

# Field rules
- minimal:
  * Normal mail: distill intent + key action verb. e.g. "Order shipped, arriving tomorrow."
  * Ads: empty string "".
  * Verification code mail: just "Code: XXXXXX", nothing else.
- summary:
  * 2-4 lines covering: gist / what to know / what to do / links (if any).
- isAd:
  * true = marketing / promo / auto-notification / newsletter / order status / platform ad / platform notice.
  * false = human mail / important system alert (login warning, CI failure, subscription delivery).
- code:
  * Output only if the email has an OTP / one-time code / verification code; otherwise null.
  * Keep only [A-Za-z0-9]{4,12}; longer or non-alphanumeric → null.
- urgency:
  * high = immediate action required (login alert, CI failure, refund fail, interview).
  * low = marketing / weekly digest / newsletter.
  * otherwise = normal.

# Important
- Return JSON only. No prose, no \`\`\` fences.
- Email body may contain HTML / preambles / multiple languages — ignore noise.`

/**
 * 极简模式的 system prompt（`design/minimal-mode.md § 3.4`）。
 *
 * 极简模式**只做一件事**：提取验证码。所以提示词也必须只做一件事 ——
 * 让它输出 `{ minimal, summary, isAd, urgency }` 是纯粹的浪费（token、延迟、
 * 以及模型「顺手」把 code 写成一句话的概率）。
 *
 * 输入 < 200 token / 输出 < 30 token，几乎免费。
 */
export const MINIMAL_SYSTEM_PROMPT = `你是验证码提取助手。阅读邮件（可能含 HTML、噪声），从中找到一次性验证码 / OTP。

# 输出 JSON Schema
{ "code": string | null }

# 规则
- 有验证码：返回 {"code": "<字母数字，仅 [A-Za-z0-9]{4,12}>"}
- 没有验证码：返回 {"code": null}
- 只保留验证码本身，不要"您的验证码是"等任何文字
- 仅返回 JSON，不要解释、不要 \`\`\` 围栏`

/**
 * 极简模式的输出 schema 描述（给「没有原生 JSON 输出」的平台用）。
 *
 * 单独一份而不是复用 `MINIMAL_SYSTEM_PROMPT`：`buildJsonSystem` 会把描述拼在
 * 基础 system 之后，两处内容重复会让模型看到两遍同样的要求（无害但浪费 token）。
 */
const MINIMAL_SCHEMA_HINT = 'Schema: { "code": string | null } —— 只输出这一个字段。'

const FULL_SCHEMA_HINT = 'Schema: { "minimal": string, "summary": string, "isAd": boolean, "code": string | null, "urgency": "low" | "normal" | "high" }'

/** 输出语言指令（`ai-prompt-design.md § 2.3`） */
function languageDirective(settings: AiSettings, browserLang: string): string {
  if (settings.outputLanguage === 'auto-email') {
    // 设计文档明确：**不做 JS 端邮件语言检测** —— AI 自己看邮件判断更可靠，少一层逻辑
    return '\n\n# Output Language\nRespond in the **same language as the email** you are summarizing.'
  }
  if (browserLang.toLowerCase().startsWith('zh'))
    return ''
  return `\n\n# Output Language\nRespond in ${browserLang}.`
}

/**
 * 拼出完整模式的 system prompt。
 *
 * 结构（顺序即优先级，**不能换**）：
 *
 *   [基础模板：语言] → [输出语言指令] → [当前规则：名称 + 用户提示词]
 *
 * 用户规则放**最后**且带明确标题：它是「场景上下文」而不是「新指令」。
 * 放前面的话，模型会把它当成覆盖性指令，进而可能不再遵守 JSON schema ——
 * 那正是设计原则 2（基础 system 不可被覆盖）要防的事。
 */
export function buildSystemPrompt(
  rule: Pick<PromptRule, 'id' | 'name' | 'prompt'> | null,
  settings: AiSettings,
  browserLang: string,
): string {
  const useZh = settings.outputLanguage !== 'auto-email' && browserLang.toLowerCase().startsWith('zh')
  const base = useZh ? ZH_SYSTEM_PROMPT : EN_SYSTEM_PROMPT

  const parts = [base, languageDirective(settings, browserLang)]

  // 内置默认规则没有用户提示词，不需要「当前规则」段
  const userPrompt = rule?.prompt?.trim()
  const isDefault = !rule || rule.id === DEFAULT_RULE_ID
  if (userPrompt && !isDefault) {
    parts.push(
      '',
      useZh ? '# 当前规则' : '# Current Rule',
      rule.name,
      '',
      useZh ? '# 规则提示词（在不违反上面的 JSON Schema 的前提下生效）' : '# Rule prompt (applies only within the JSON Schema above)',
      userPrompt.slice(0, MAX_RULE_PROMPT_CHARS),
    )
  }

  return parts.filter(part => part !== undefined).join('\n')
}

/**
 * 拼出极简模式的 system prompt。
 *
 * 极简模式**不吃用户规则**（设计文档 `design/minimal-mode.md § 2`：极简模式没有
 * 「多 PromptRule 匹配」这项能力）。所以这里只有基础模板 + 输出语言指令。
 */
export function buildMinimalSystemPrompt(settings: AiSettings, browserLang: string): string {
  return `${MINIMAL_SYSTEM_PROMPT}${languageDirective(settings, browserLang)}`
}

/**
 * 正文截断。
 *
 * 截断处**显式标注**（`[已截断，原文 N 字]`）：模型看到这句话才知道自己拿到的不是
 * 全文，否则它会基于「正文到此结束」做出错误判断（比如把被截掉的签名档当成缺失）。
 * 这个标注也是给用户看的 —— 在 Options 与文档里都说明「用户规则里要求"完整正文"
 * 会受截断影响，这是有意为之的成本控制」。
 */
export function truncateBody(text: string, max = MAX_BODY_CHARS): string {
  if (text.length <= max)
    return text
  return `${text.slice(0, max)}\n\n[已截断，原文 ${text.length} 字]`
}

/**
 * 拼出用户消息（邮件本身）。
 *
 * 头部字段放在正文之前，且**即使超长也不截断**：subject / from / date 是判断一封
 * 邮件性质最关键的三个信号（设计文档 § 1 原则 4：「提示词要求"先看 subject / from"」），
 * 而它们最多几十个字。
 *
 * `List-Unsubscribe` 单独列出：它是**广告判定最可靠的单点信号**，
 * 有这个头几乎一定是群发。
 */
export function buildUserContent(mail: Mail, maxBody = MAX_BODY_CHARS): string {
  const from = mail.from.map(item => (item.name ? `${item.name} <${item.address}>` : item.address)).join(', ')
  const to = mail.to.map(item => item.address).join(', ')

  const header = [
    `From: ${from || '(未知)'}`,
    to ? `To: ${to}` : '',
    `Subject: ${mail.subject || '(无主题)'}`,
    `Date: ${new Date(mail.receivedAt).toISOString()}`,
    mail.listUnsubscribe ? `List-Unsubscribe: ${mail.listUnsubscribe}` : '',
  ].filter(Boolean)

  const body = truncateBody((mail.bodyText ?? mail.snippet ?? '').trim(), maxBody)

  return [
    ...header,
    '',
    '--- Body ---',
    body || '(正文为空)',
  ].join('\n')
}

/** 极简模式的用户消息：只要「发件人 + 主题 + 正文」，不要 List-Unsubscribe 之类的噪音 */
export function buildMinimalUserContent(mail: Mail, maxBody = MAX_BODY_CHARS): string {
  const body = truncateBody((mail.bodyText ?? mail.snippet ?? '').trim(), maxBody)
  return [
    `From: ${formatSender(mail.from)}`,
    `Subject: ${mail.subject || '(无主题)'}`,
    '',
    '--- Body ---',
    body || '(正文为空)',
  ].join('\n')
}

/**
 * 按平台能力选择「怎么要 JSON」。
 *
 *   - `nativeJson: true` → 让协议层打开原生 JSON 模式（OpenAI 发 `response_format`）
 *   - `nativeJson: false` → 完全靠 prompt 约束，此时**必须**把 schema 描述拼进去，
 *     否则模型没有任何结构提示（Anthropic 走的就是这条）
 *
 * 无论走哪条，system prompt 里都已经含 "JSON" 字样（基础模板里有），
 * 满足 DeepSeek 的硬要求。
 */
export function withSchemaHint(system: string, provider: AiProvider, mode: 'full' | 'minimal'): string {
  if (provider.capabilities.nativeJson)
    return system

  const hint = mode === 'minimal' ? MINIMAL_SCHEMA_HINT : FULL_SCHEMA_HINT
  return [
    system,
    '',
    '# 输出要求',
    '- 只输出一个合法的 JSON 对象，不要输出任何解释性文字',
    '- 不要用 markdown 代码块包裹',
    hint,
  ].join('\n')
}

/**
 * 请求的「固定开销」字符数（不含邮件正文）。
 *
 * 存在的意义：`capabilities.maxInputChars` 要用来裁剪正文，而预算必须扣掉
 * system + 消息包装的固定部分 —— 否则「用户把规则提示词写得很长」这件事
 * 完全不进预算，裁剪结果照样超限。
 *
 * ⚠ 让这个函数**报告真实开销**，而不是在调用方那边估一个常量：
 *   估出来的常量会随着 system 文案改动静默失准（offer-hunter 里那个
 *   `PROMPT_RESERVE = 2000` 就是这么来的，后来文案改了它也没人动）。
 */
export function jsonRequestOverhead(system: string, userContentWithoutBody: string): number {
  return system.length + userContentWithoutBody.length
}

/** 一封信在给定平台预算下允许的正文长度 */
export function bodyBudget(provider: AiProvider, system: string, headerChars: number): number {
  const available = provider.capabilities.maxInputChars - jsonRequestOverhead(system, ' '.repeat(headerChars))
  // 至少留 500 字：预算再紧也要让模型看到点正文，否则它只能靠主题猜（还不如降级）
  return Math.max(500, Math.min(MAX_BODY_CHARS, available))
}
