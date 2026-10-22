import type { AiOutput, Expiry, Mail, MailTypeAdapter, MailTypeMatch } from '~/logic/types'
import { z } from 'zod'
import { formatSender, htmlToText } from '~/adapters/mail/parser'
import { parseSafeHttpUrl } from '~/logic/mail-types/url'
import { MailStateFlag, mailStateFlagsFromStates } from '~/logic/types'

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

const expiryFields = {
  validForSeconds: z.union([z.number(), z.string(), z.null()]).optional().catch(null),
  expiresAt: z.union([z.string(), z.number(), z.null()]).optional().catch(null),
}

const codeDataSchema = z.object({
  value: z.union([z.string(), z.null()]).optional(),
  ...expiryFields,
})

const confirmDataSchema = z.object({
  url: z.union([z.string(), z.null()]).optional(),
  label: z.union([z.string(), z.null()]).optional(),
  ...expiryFields,
})

const summaryDataSchema = z.object({
  minimal: z.string().optional().catch(''),
  text: z.string().optional().catch(''),
})

const customDataSchema = z.object({
  text: z.string().optional().catch(''),
})

const typeMatchSchema = z.object({
  adapterId: z.string(),
  code: codeDataSchema.optional(),
  confirm: confirmDataSchema.optional(),
  summary: summaryDataSchema.optional(),
  custom: customDataSchema.optional(),
})

export const aiResultSchema = z.object({
  /*
   * `types` 是**必填**（哪怕是空数组）。
   *
   * ⚠ 不能写成 `.catch([])`：模型返回 `{}` 时会被悄悄当成「没有任何类型命中」，
   *   既不会重试也不会降级 —— 用户看到的是一封「处理过但什么也没有」的邮件。
   *   缺字段 = 结构性错误，应该走重试 / 降级。
   */
  types: z.array(typeMatchSchema).max(20),
  states: z.array(z.enum(['ad', 'urgent', 'low'])).max(3).catch([]),
})

export type AiResultSchema = z.infer<typeof aiResultSchema>

/** 一次 AI 分析的结果：邮件级状态位 + 类型命中 */
export interface AiResult {
  output: AiOutput
  stateFlags: number
}

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

function roundSeconds(seconds: number): number | null {
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

// ---------------------------------------------------------------------------
// 类型命中解析
// ---------------------------------------------------------------------------

export interface ResolveContext {
  adapters: MailTypeAdapter[]
  mail: Mail
}

function buildMatch(
  adapter: MailTypeAdapter,
  raw: AiResultSchema['types'][number],
  mail: Mail,
): MailTypeMatch | null {
  if (adapter.ui === 'code') {
    const code = cleanCode(raw.code?.value)
    if (!code)
      return null
    return {
      kind: 'code',
      adapterId: adapter.id,
      adapterName: adapter.name,
      code,
      expiry: resolveExpiry(mail, raw.code ?? {}, MAX_CODE_VALID_FOR_SECONDS),
    }
  }

  if (adapter.ui === 'confirm') {
    const parsed = parseSafeHttpUrl(raw.confirm?.url)
    if (!parsed)
      return null
    return {
      kind: 'confirm',
      adapterId: adapter.id,
      adapterName: adapter.name,
      url: parsed.toString(),
      host: parsed.host,
      label: raw.confirm?.label?.trim().slice(0, 80) || undefined,
      expiry: resolveExpiry(mail, raw.confirm ?? {}, MAX_CONFIRM_VALID_FOR_SECONDS),
    }
  }

  if (adapter.ui === 'summary') {
    const minimal = (raw.summary?.minimal ?? '').trim().slice(0, 200)
    const text = (raw.summary?.text ?? '').trim().slice(0, 4000)
    if (!minimal && !text)
      return null
    return { kind: 'summary', adapterId: adapter.id, adapterName: adapter.name, minimal, text }
  }

  // 自定义类型：只认一段文本
  const text = (raw.custom?.text ?? '').trim().slice(0, 4000)
  if (!text)
    return null
  return { kind: 'custom', adapterId: adapter.id, adapterName: adapter.name, text }
}

/**
 * 业务层二次校验。
 *
 * 返回的 `types` 已按适配器优先级排序、已应用兜底；`stateFlags` 已转成位掩码。
 */
export function resolveAiTypes(
  parsed: AiResultSchema,
  context: ResolveContext,
): AiResult {
  const enabled = new Map(
    context.adapters
      .filter(adapter => adapter.enabled)
      .map(adapter => [adapter.id, adapter]),
  )

  const entries: Array<{ match: MailTypeMatch, priority: number, fallback: boolean }> = []
  const seen = new Set<string>()

  for (const raw of parsed.types) {
    const adapter = enabled.get(raw.adapterId)
    if (!adapter || seen.has(adapter.id))
      continue
    const match = buildMatch(adapter, raw, context.mail)
    if (!match)
      continue
    seen.add(adapter.id)
    entries.push({ match, priority: adapter.priority, fallback: adapter.fallback })
  }

  /*
   * 兜底规则（需求 8）：
   *   - 只要有任何非兜底类型命中，所有兜底类型都不输出（验证码命中 ⇒ 没有总结）；
   *   - 否则只保留优先级最高的一个兜底（自定义兜底 vs 总结，谁靠前谁赢）。
   *
   * ⚠ 这是 **JS 强制**的，不依赖模型是否遵守提示词里的「兜底」说明。
   */
  const primary = entries.filter(entry => !entry.fallback)
  const chosen = primary.length
    ? primary
    : entries
        .filter(entry => entry.fallback)
        .sort((a, b) => a.priority - b.priority)
        .slice(0, 1)

  const types = chosen
    .sort((a, b) => a.priority - b.priority)
    .map(entry => entry.match)

  return {
    output: deriveAiOutput(types),
    stateFlags: mailStateFlagsFromStates(parsed.states),
  }
}

/** 从 types 派生兼容旧 UI 的字段（唯一真相仍是 `types`） */
function deriveAiOutput(types: MailTypeMatch[]): AiOutput {
  const codeMatch = types.find((match): match is Extract<MailTypeMatch, { kind: 'code' }> => match.kind === 'code')
  const summaryMatch = types.find((match): match is Extract<MailTypeMatch, { kind: 'summary' }> => match.kind === 'summary')

  return {
    types,
    minimal: summaryMatch?.minimal,
    summary: summaryMatch?.text,
    code: codeMatch?.code ?? null,
    validForSeconds: codeMatch?.expiry?.totalSeconds ?? null,
  }
}

/** 校验 + 装配（AI 返回的原文 → AiResult，失败返回 error） */
export function parseAiResult(
  text: string,
  context: ResolveContext,
): { ok: true, result: AiResult } | { ok: false, error: string } {
  let json: unknown
  try {
    json = parseJsonLoose(text)
  }
  catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }

  const parsed = aiResultSchema.safeParse(json)
  if (!parsed.success)
    return { ok: false, error: `AI 输出不符合 schema：${JSON.stringify(parsed.error.issues).slice(0, 300)}` }

  return { ok: true, result: resolveAiTypes(parsed.data, context) }
}

// ---------------------------------------------------------------------------
// 降级
// ---------------------------------------------------------------------------

/**
 * 降级结果（`features/02-ai-summary.md § 5`）。
 *
 * 设计原则：**AI 挂了也要能看到邮件**。所以降级不是「空记录 + 错误」，
 * 而是「用启发式规则尽力填一份 + 标记 degraded」。
 *
 * - 验证码：`heuristicCode` 启发式提取（仅当 code 适配器启用）；
 * - 总结：仅当 summary 适配器启用时，用邮件基础信息 + snippet 拼一份；
 * - states：有 `List-Unsubscribe` ⇒ Ad。
 */
export function fallbackResult(
  mail: Mail,
  adapters: MailTypeAdapter[],
  error: string,
): AiResult {
  const enabled = adapters.filter(adapter => adapter.enabled)
  const types: MailTypeMatch[] = []

  const codeAdapter = enabled.find(adapter => adapter.ui === 'code')
  if (codeAdapter) {
    const code = heuristicCode(mail)
    if (code) {
      types.push({
        kind: 'code',
        adapterId: codeAdapter.id,
        adapterName: codeAdapter.name,
        code,
      })
    }
  }

  const summaryAdapter = enabled.find(adapter => adapter.ui === 'summary')
  // 降级路径同样遵守兜底规则：验证码命中时不再生成总结
  if (summaryAdapter && !types.some(match => match.kind === 'code')) {
    types.push({
      kind: 'summary',
      adapterId: summaryAdapter.id,
      adapterName: summaryAdapter.name,
      minimal: buildFallbackMinimal(mail),
      text: buildFallbackSummary(mail, error),
    })
  }

  const output = deriveAiOutput(types)
  output.degraded = true
  output.error = error

  return {
    output,
    stateFlags: heuristicIsAd(mail) ? MailStateFlag.Ad : MailStateFlag.None,
  }
}

function buildFallbackMinimal(mail: Mail): string {
  const sender = formatSender(mail.from)
  const subject = mail.subject.trim()
  return (subject ? `${sender}：${subject.slice(0, 30)}` : sender).slice(0, 200)
}

function buildFallbackSummary(mail: Mail, error: string): string {
  const lines = [
    `- 发件人：${formatSender(mail.from)}`,
    `- 主题：${mail.subject || '(无主题)'}`,
    `- 时间：${new Date(mail.receivedAt).toLocaleString('zh-CN')}`,
  ]

  const preview = (mail.snippet || mail.bodyText || '').trim()
  if (preview)
    lines.push('', preview.slice(0, 400))

  lines.push('', `> ⚠️ AI 处理失败，以上为邮件基础信息。原因：${error}`)
  return lines.join('\n')
}

/**
 * 启发式广告判定。
 *
 * 判据只有一条：**带 `List-Unsubscribe` 头的邮件几乎一定是群发**（营销 / 通知 /
 * Newsletter），因为真人写邮件不会给你一个「退订」链接。
 *
 * ⚠ 但它**不能反过来用**：没有这个头不等于不是广告（很多平台推广不带它）。
 *   所以这只在 AI 失败时兜底，正常路径永远以 AI 的 `states` 为准。
 */
export function heuristicIsAd(mail: Pick<Mail, 'listUnsubscribe'>): boolean {
  return !!mail.listUnsubscribe
}

/**
 * 启发式验证码提取。
 *
 * 策略是「**先找关键词，再在它附近找验证码**」，而不是写一条「关键词 + 任意字符 +
 * 字母数字」的大正则。后者有一个真实的坑：`[^\dA-Za-z]{0,12}([A-Za-z0-9]{4,12})`
 * 里的 `{0,12}` 是**贪婪**的，在 `Your verification code is 90210.` 上它会先吃掉
 * `code is 9021`（正好 12 个字符），于是捕获组只拿到 `0`，长度不够而匹配失败。
 *
 * 关键词的位置才是真正的锚点：验证码几乎总在关键词后面十几个字符内，
 * 取一个固定窗口再看窗口里有什么，比在大正则里调量词可靠得多。
 */
const CODE_KEYWORDS = [
  /验[证証][码碼]/g,
  /校验码/g,
  /动态(?:密码|码)/g,
  /一次性密码/g,
  /確認コード/g,
  /認証コード/g,
  /인증\s*(?:번호|코드)/g,
  /verification\s+code/gi,
  /verify\s+code/gi,
  /security\s+code/gi,
  /one[-\s]?time\s+(?:code|password|pin)/gi,
  /passcode/gi,
  /\botp\b/gi,
]

/** 关键词之后多长的窗口里找验证码 */
const KEYWORD_WINDOW = 60

export function heuristicCode(mail: Pick<Mail, 'subject' | 'bodyText' | 'snippet'>): string | null {
  const text = `${mail.subject}\n${mail.bodyText ?? mail.snippet ?? ''}`

  // 1. 关键词附近的字母数字串（可信度最高）
  for (const pattern of CODE_KEYWORDS) {
    // 这些正则都带 `g`，复用同一个实例时 `lastIndex` 会串味，所以每次重建
    const scanner = new RegExp(pattern.source, pattern.flags)
    for (;;) {
      const match = scanner.exec(text)
      if (!match)
        break

      const window = text.slice(match.index + match[0].length, match.index + match[0].length + KEYWORD_WINDOW)
      const candidate = firstCodeLikeToken(window)
      if (candidate)
        return candidate
    }
  }

  // 2. 主题里独立的 4-8 位数字（`你的登录码 7788` 这种关键词没写全的情况）
  const subjectMatch = /(?:^|\s)(\d{4,8})(?:\s|$|[，。,.])/.exec(mail.subject ?? '')
  if (subjectMatch)
    return cleanCode(subjectMatch[1])

  return null
}

/** 窗口里第一个「像验证码」的字母数字串 */
function firstCodeLikeToken(window: string): string | null {
  const tokens = window.match(/\b[A-Z0-9]{4,12}\b/gi)
  if (!tokens?.length)
    return null
  // 含数字的优先：窗口里可能先出现一个英文单词（`is`、`code`），再出现真正的验证码
  const withDigit = tokens.find(token => /\d/.test(token))
  return withDigit ? cleanCode(withDigit) : null
}

/**
 * 从 HTML 里抽验证码（`html` 只在解析阶段存在，入库时已被丢弃）。
 *
 * 目前没有生产调用方 —— 保留是因为「只用 HTML 的邮件」（有些平台只发 HTML 部分）
 * 是我们已知会遇到的形态，而 `htmlToText` 已经写好了，接上只要一行。
 */
export function heuristicCodeFromHtml(html: string): string | null {
  return heuristicCode({ subject: '', bodyText: htmlToText(html), snippet: '' })
}

/**
 * 容错解析模型返回的 JSON。
 *
 * 模型经常在 JSON 外面包一层 ```json 代码块，或前后带解释性文字 ——
 * 即使提示词明确说了「不要」，这件事依然会发生（各家模型的遵循度不同）。
 *
 * ⚠ 刻意不用正则剥代码块：`/```(?:json)?\s*([\s\S]*?)```/` 有回溯风险，
 *   而这里处理的正是**不可信输入**（模型输出），不能给它留 ReDoS 的口子。
 */
export function parseJsonLoose(text: string): unknown {
  const trimmed = text.trim()
  if (!trimmed)
    throw new Error('模型返回了空内容')

  try {
    return JSON.parse(trimmed)
  }
  catch {
    // 继续尝试剥离
  }

  // ```json ... ```
  if (trimmed.startsWith('```')) {
    const firstNewline = trimmed.indexOf('\n')
    const fenceEnd = trimmed.indexOf('```', 3)
    if (firstNewline !== -1 && fenceEnd > firstNewline) {
      try {
        return JSON.parse(trimmed.slice(firstNewline + 1, fenceEnd).trim())
      }
      catch {
        // 继续尝试
      }
    }
  }

  // 截取第一个 { 到最后一个 }
  const start = trimmed.indexOf('{')
  const end = trimmed.lastIndexOf('}')
  if (start !== -1 && end > start) {
    try {
      return JSON.parse(trimmed.slice(start, end + 1))
    }
    catch {
      // 落到下面抛错
    }
  }

  throw new Error(`无法从模型返回中解析出 JSON：${trimmed.slice(0, 200)}`)
}
