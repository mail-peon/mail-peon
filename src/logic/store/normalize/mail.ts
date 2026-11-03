import type { AiOutput, Mail, MailAddress, MailTypeMatch } from '~/logic/types'
import { BUILTIN_CODE_ID, BUILTIN_SUMMARY_ID, mailStateFlagsFromLegacy, normalizeMailStateFlags } from '~/logic/types'
import { asObject, bool, isPlainObject, num, optionalStr, positiveNumber, str } from './common'
import { normalizeLinks, normalizeMailTypeMatches } from './mail-type'
// ---------------------------------------------------------------------------
// 地址 / 匹配器 / 屏蔽项
// ---------------------------------------------------------------------------

/**
 * 正文入库上限（比喂 AI 的 6000 字宽，够用户展开看）。
 *
 * ⚠ 声明放在使用点**之前**：`const` 在模块顶层也有 TDZ，而 `normalizeMail` 里用了它 ——
 *   类型检查通不过（`ts/no-use-before-define`），运行时更是直接
 *   `Cannot access 'MAX_BODY_CHARS' before initialization`。
 *   这个数字与 AI 侧的 `prompt-build.MAX_BODY_CHARS` 是**两个不同的量**：
 *   那个是「喂给模型的截断」，这个是「入库的上限」，别合并。
 */
export const MAX_BODY_CHARS = 50_000

export function normalizeAddresses(raw: unknown): MailAddress[] {
  if (!Array.isArray(raw))
    return []
  const out: MailAddress[] = []
  for (const item of raw) {
    if (typeof item === 'string') {
      // `"Name <a@b.com>"` / `"a@b.com"` 两种都要吃下
      const parsed = parseAddressString(item)
      if (parsed)
        out.push(parsed)
      continue
    }
    if (!isPlainObject(item))
      continue
    const address = str(item.address).trim().toLowerCase()
    if (!address)
      continue
    out.push({ name: str(item.name), address })
  }
  return out
}

/**
 * 解析 `Name <a@b.com>` 形态的地址串。
 *
 * ⚠ 刻意**不用一条正则搞定**（`/^\s*(.*?)\s*<([^>]+)>\s*$/`）：那种写法里
 *   `\s*` 与 `.*?` 的字符集重叠，是 super-linear 回溯的经典形态 ——
 *   而这个函数的输入是**邮件头**（发件人可任意构造），等于把 ReDoS 的口子
 *   开在了不可信输入上。
 *
 * 手工按 `<>` 切分没有回溯，行为也更好解释。
 */
export function parseAddressString(input: string): MailAddress | null {
  const text = input.trim()
  if (!text)
    return null

  const open = text.lastIndexOf('<')
  const close = text.lastIndexOf('>')
  if (open !== -1 && close > open) {
    const address = text.slice(open + 1, close).trim().toLowerCase()
    if (!address)
      return null
    // 显示名可能被引号包着（`"Doe, John" <j@x.com>`）
    const name = text.slice(0, open).trim().replace(/^"(.*)"$/, '$1')
    return { name, address }
  }

  if (text.includes('@'))
    return { name: '', address: text.toLowerCase() }

  return null
}

// ---------------------------------------------------------------------------
// 邮件
// ---------------------------------------------------------------------------

export function normalizeMail(raw: unknown, fallbackKey?: string): Mail | null {
  const value = asObject(raw)
  const id = str(value.id, fallbackKey ?? '')
  const accountId = str(value.accountId)
  if (!id || !accountId)
    return null

  const processing = value.processing === 'sent' || value.processing === 'skipped'
    ? value.processing
    : 'pending'
  const copyStatus = value.copyStatus === 'copied' || value.copyStatus === 'failed'
    ? value.copyStatus
    : 'none'

  const legacyExpiresAt = positiveNumber(value.codeExpiresAt)
  const legacyValidSeconds = positiveNumber(value.codeValidForSeconds)
  const ai = normalizeAiOutput(value.ai, {
    codeExpiresAt: legacyExpiresAt,
    codeValidForSeconds: legacyValidSeconds,
  })
  const codeMatch = ai?.types.find(match => match.kind === 'code')
  const code = (typeof value.code === 'string' && value.code) || codeMatch?.code || null

  /*
   * 状态位掩码：
   *   - 新数据直接读 `stateFlags`；
   *   - 老数据（只有 `ai.isAd` / `ai.urgency`）在这里迁移。
   * ⚠ 必须在 `ai` 归一之后算：`normalizeAiOutput` 不负责状态位，避免两处都写。
   */
  const stateFlags = value.stateFlags !== undefined
    ? normalizeMailStateFlags(value.stateFlags)
    : (() => {
        const legacyAi = isPlainObject(value.ai) ? value.ai : undefined
        return mailStateFlagsFromLegacy(legacyAi?.isAd, legacyAi?.urgency)
      })()

  return {
    id,
    accountId,
    from: normalizeAddresses(value.from),
    to: normalizeAddresses(value.to),
    cc: value.cc === undefined ? undefined : normalizeAddresses(value.cc),
    subject: str(value.subject),
    snippet: str(value.snippet).slice(0, 240),
    bodyText: typeof value.bodyText === 'string' ? value.bodyText.slice(0, MAX_BODY_CHARS) : undefined,
    bodyHtml: undefined, // MVP 不存 HTML，归一化时直接丢掉存量里的
    receivedAt: num(value.receivedAt, Date.now()),
    processing,
    ai,
    copyStatus,
    read: bool(value.read, false),
    dismissed: value.dismissed === undefined ? undefined : bool(value.dismissed, false),
    stateFlags,
    links: normalizeLinks(value.links),
    /*
     * 回收站标记（v2）。
     *
     * ⚠ 必须是**正数**才认：`0` / 负数 / `NaN` 会让它落进 `by-trashedAt` 索引的
     *   诡异位置（`0` 排在最前），而且 UI 上会显示「1970 年删除的邮件」。
     *   归一成 `undefined` 就等于「不在这封邮件的回收站里」。
     */
    trashedAt: positiveNumber(value.trashedAt),
    code,
    /*
     * 验证码失效时刻。
     *
     * ⚠ 必须是**正数**：`0` / 负数 / `NaN` 会让倒计时立刻显示「失效」，
     *   而那与「没有有效期信息」在 UI 上是两回事（后者根本不展示倒计时）。
     *   新数据优先用 match 里的 expiry；老数据只有顶层字段。
     */
    codeExpiresAt: legacyExpiresAt ?? codeMatch?.expiry?.at,
    codeValidForSeconds: legacyValidSeconds ?? codeMatch?.expiry?.totalSeconds,
    messageId: optionalStr(value.messageId),
    listUnsubscribe: optionalStr(value.listUnsubscribe),
    ruleId: optionalStr(value.ruleId),
  }
}

/**
 * `Mail.ai` 的归一。
 *
 * ⚠ 这个函数放在 `normalizeMail` **之后**（而不是紧挨着它）：`tsc` 对
 *   「块级作用域变量在声明前被使用」是硬报错（TS2448），所以 `MAX_BODY_CHARS`
 *   必须先声明 —— 它现在住在文件上方的「地址 / 匹配器」段里。
 *
 * ## 老数据合成 match
 *
 * 升级前只有 `ai.code` / `ai.summary` / `ai.minimal`。这里把它们合成对应的
 * match，UI 就不需要到处写「新数据读 types、老数据读 ai.code」的分支。
 */
export function normalizeAiOutput(
  raw: unknown,
  legacy?: { codeExpiresAt?: number, codeValidForSeconds?: number },
): AiOutput | undefined {
  if (!isPlainObject(raw))
    return undefined

  const types = normalizeMailTypeMatches(raw.types)

  const legacyCode = typeof raw.code === 'string' && raw.code ? raw.code : null
  const legacySeconds = positiveNumber(raw.validForSeconds)
  if (legacyCode && !types.some(match => match.kind === 'code')) {
    types.push({
      kind: 'code',
      adapterId: BUILTIN_CODE_ID,
      adapterName: '',
      code: legacyCode,
      expiry: legacy?.codeExpiresAt && legacy?.codeValidForSeconds
        ? { at: legacy.codeExpiresAt, totalSeconds: legacy.codeValidForSeconds }
        : undefined,
    })
  }

  const legacySummary = str(raw.summary)
  const legacyMinimal = str(raw.minimal)
  if ((legacySummary || legacyMinimal) && !types.some(match => match.kind === 'summary')) {
    types.push({
      kind: 'summary',
      adapterId: BUILTIN_SUMMARY_ID,
      adapterName: '',
      minimal: legacyMinimal,
      text: legacySummary,
    })
  }

  const codeMatch = types.find((match): match is Extract<MailTypeMatch, { kind: 'code' }> => match.kind === 'code')
  const summaryMatch = types.find((match): match is Extract<MailTypeMatch, { kind: 'summary' }> => match.kind === 'summary')

  return {
    types,
    minimal: summaryMatch?.minimal || legacyMinimal,
    summary: summaryMatch?.text || legacySummary,
    code: codeMatch?.code ?? legacyCode,
    validForSeconds: codeMatch?.expiry?.totalSeconds ?? legacySeconds ?? null,
    degraded: raw.degraded === undefined ? undefined : bool(raw.degraded, false),
    error: optionalStr(raw.error),
  }
}
