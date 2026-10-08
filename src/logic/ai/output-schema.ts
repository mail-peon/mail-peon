import type { AiOutput, Mail, Urgency } from '~/logic/types'
import { z } from 'zod'
import { formatSender, htmlToText } from '~/adapters/mail/parser'

/**
 * AI 输出的 zod schema 与降级策略。
 *
 * 设计文档的原则（`design/ai-prompt-design.md § 1`）：**AI 永远返回固定 schema 的
 * JSON；失败 = zod 校验失败 → 重试 1 次 → 降级**。这里是那条链路的最后一环。
 *
 * ⚠ 为什么 schema 比提示词宽松（提示词说 ≤60 字，这里给 120）：
 *   zod 的职责是**挡住结构性错误**（少字段、类型不对、枚举值乱写），不是替模型
 *   数汉字。把长度卡死在提示词承诺的数字上，会让「模型多写了 10 个字」这种
 *   完全可接受的结果被判定为失败、整封邮件走降级 —— 那是拿可靠性换洁癖。
 *   长度由提示词约束，这里只兜住「离谱到没法展示」的情况（1200 字）。
 */

/** 验证码：只保留 `[A-Za-z0-9]{4,12}`，与提示词的承诺一致 */
export const CODE_PATTERN = /^[A-Z0-9]{4,12}$/i

export const aiOutputSchema = z.object({
  minimal: z.string().max(200).catch(''),
  summary: z.string().max(4000).catch(''),
  isAd: z.boolean().catch(false),
  /*
   * `code` 刻意**不用** z.string().regex() —— 那样一个多余的 "-" 会让整条记录
   * 掉进降级分支，丢掉本来完全可用的 summary 与 minimal。
   * 这里先宽松地收下，再由下面的 `cleanCode()` 决定要不要留。
   */
  code: z.union([z.string(), z.null()]).optional().catch(null),
  urgency: z.enum(['low', 'normal', 'high']).catch('normal'),
})

export type AiOutputSchema = z.infer<typeof aiOutputSchema>

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
   *   一个 10 位的字母数字串，正好符合 `[A-Za-z0-9]{4,12}`，于是「关键词 + 验证码」
   *   这种最常见的模型输出会被当成验证码本身。
   */
  const digitsOnly = trimmed.replace(/[\s-]/g, '')
  if (/^\d{4,12}$/.test(digitsOnly))
    return digitsOnly

  /*
   * 3. 从文本里抽第一个 4-12 位字母数字串。
   *
   * ⚠ 用 `\b` 边界而不是裸扫描：正文里的 "Order #12345 shipped" 不该被当成验证码，
   *   而 `\b` 至少能排除掉粘连在更长单词里的片段。
   */
  const tokens = trimmed.match(/\b[A-Z0-9]{4,12}\b/gi)
  if (!tokens?.length)
    return null

  /*
   * 挑「最像验证码」的那个：**含数字**优先于纯字母。
   * 纯字母候选（如 "code"、"This"）几乎都是正文里的普通单词；
   * 而真实验证码绝大多数是纯数字或数字+字母。
   */
  const withDigit = tokens.find(token => /\d/.test(token))
  return withDigit ?? null
}

/** 把 zod 的输出装配成 `AiOutput` */
export function toAiOutput(parsed: AiOutputSchema): AiOutput {
  return {
    minimal: parsed.minimal.trim(),
    summary: parsed.summary.trim(),
    isAd: parsed.isAd,
    code: cleanCode(parsed.code),
    urgency: parsed.urgency,
  }
}

/**
 * 降级输出（`features/02-ai-summary.md § 5`）。
 *
 * 设计原则：**AI 挂了也要能看到邮件**。所以降级不是「空记录 + 错误」，
 * 而是「用启发式规则尽力填一份 + 标记 degraded」。
 *
 * 每个字段的兜底来源：
 *   minimal  ← 发件人 + 主题前 30 字
 *   summary  ← 正文已有片段（`snippet`，入库时就存过）
 *   isAd     ← 启发式：有 `List-Unsubscribe` 头 ⇒ 大概率是群发 / 营销
 *   code     ← 正则启发式（比 AI 差，但比「拿不到」强）
 *   urgency  ← normal（不猜）
 */
export function fallbackOutput(mail: Mail, error: string): AiOutput {
  const sender = formatSender(mail.from)
  const subject = mail.subject.trim()
  const minimal = subject
    ? `${sender}：${subject.slice(0, 30)}`
    : sender

  return {
    minimal: minimal.slice(0, 200),
    summary: buildFallbackSummary(mail, error),
    isAd: heuristicIsAd(mail),
    code: heuristicCode(mail),
    urgency: 'normal',
    degraded: true,
    error,
  }
}

function buildFallbackSummary(mail: Mail, error: string): string {
  const lines = [
    `- 发件人：${formatSender(mail.from)}`,
    `- 主题：${mail.subject || '(无主题)'}`,
    `- 时间：${new Date(mail.receivedAt).toLocaleString('zh-CN')}`,
  ]

  /*
   * ⚠ 优先 `snippet` 而不是 `bodyText`：`snippet` 就是「正文前 240 字」，
   *   本来就是为这种「快速看一眼」的场景存的。用 `bodyText` 的话要现场 slice，
   *   而且**极简模式的记录根本没有 bodyText**（只存 code），于是降级摘要会变成空的。
   */
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
 *   所以这只在 AI 失败时兜底，正常路径永远以 AI 的 `isAd` 为准。
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
 * `code is 9021`（正好 12 个字符），于是捕获组只拿到 `0`，长度不够而匹配失败 ——
 * 结果是一封明明白白写着验证码的邮件被判为「没有验证码」。
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

/** 校验 + 装配一把梭（AI 返回的原文 → `AiOutput`，失败返回 null） */
export function parseAiOutput(text: string): { ok: true, output: AiOutput } | { ok: false, error: string } {
  let json: unknown
  try {
    json = parseJsonLoose(text)
  }
  catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }

  const parsed = aiOutputSchema.safeParse(json)
  if (!parsed.success)
    return { ok: false, error: `AI 输出不符合 schema：${JSON.stringify(parsed.error.issues).slice(0, 300)}` }

  return { ok: true, output: toAiOutput(parsed.data) }
}

/**
 * 容错解析模型返回的 JSON。
 *
 * 模型经常在 JSON 外面包一层 ```json 代码块，或前后带解释性文字 ——
 * 即使提示词明确说了「不要」，这件事依然会发生（各家模型的遵循度不同）。
 * 在这里兜住比在提示词里反复强调有效得多。
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

export type { Urgency }
