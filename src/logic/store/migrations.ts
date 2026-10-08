/**
 * 纯归一化函数。
 *
 * 这一层**只有纯函数**：不碰存储、不读环境、不写任何东西，所以可单测、可干跑。
 * 存储层（`settings.ts` / `accounts.ts` / …）负责「取出来 / 放进去」，
 * 门面（各仓库的 read 函数）决定在哪一步调用这些归一化。
 *
 * 归一化混进存储层的话，干跑预览与真实迁移会走出两条不同的路 —— 而那条路
 * 只在「存量数据形状不新」时才被走到，平时看不出来。
 */

import type {
  AiOutput,
  AiSettings,
  AppSettings,
  BlockedEntry,
  Mail,
  MailAccount,
  MailAddress,
  MailProviderId,
  MailRetention,
  Matcher,
  PromptRule,
  SyncCursor,
} from '~/logic/types'
import {
  createDefaultAiSettings,
  createDefaultAppSettings,
  DEFAULT_RULE_ID,
  MAIL_RETENTION_OPTIONS,
} from '~/logic/types'

// ---------------------------------------------------------------------------
// 基础取值
// ---------------------------------------------------------------------------

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function asObject(value: unknown): Record<string, unknown> {
  // 早期版本可能用 `useWebExtensionStorage` 把对象 JSON 字符串化过 —— 复活它
  if (typeof value === 'string') {
    try {
      return asObject(JSON.parse(value))
    }
    catch {
      return {}
    }
  }
  return isPlainObject(value) ? value : {}
}

function str(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback
}

function num(value: unknown, fallback: number): number {
  if (typeof value === 'number' && Number.isFinite(value))
    return value
  if (typeof value === 'string') {
    const parsed = Number(value)
    if (Number.isFinite(parsed))
      return parsed
  }
  return fallback
}

function bool(value: unknown, fallback: boolean): boolean {
  if (typeof value === 'boolean')
    return value
  if (value === 'true')
    return true
  if (value === 'false')
    return false
  return fallback
}

/**
 * 把任意形状的值补成 `fallback` 的形状。
 *
 * 规则：**只按 fallback 声明过的键合并**。fallback 里没有的键一律丢弃 ——
 * 否则「模型删了一个字段」之后，存量数据里那个字段会一直躺着并被读出来，
 * 类型上却已经不存在了。
 *
 * ⚠ 内部的 `mergeObject` 用 `Record<string, unknown>` 而不是递归泛型：递归泛型
 *   在这里会让 TS 的推断退化（`T[K]` 的映射类型碰上 `unknown` 输入时会报
 *   「unknown 不能赋给 T」）。用 `unknown` 组装完在**唯一一处**收口成 `T` 更简单，
 *   也更诚实地表达了「这一步本来就是运行时的形状对齐，不是类型推导」。
 */
export function mergeDefaults<T>(raw: unknown, fallback: T): T {
  if (Array.isArray(fallback)) {
    const value = typeof raw === 'string' ? safeJson(raw) : raw
    return (Array.isArray(value) ? value : fallback) as T
  }

  if (isPlainObject(fallback))
    return mergeObject(raw, fallback as Record<string, unknown>) as T

  return coerceLike(raw, fallback) as T
}

function mergeObject(raw: unknown, seed: Record<string, unknown>): Record<string, unknown> {
  const value = asObject(raw)
  const out: Record<string, unknown> = {}
  for (const [key, child] of Object.entries(seed)) {
    if (!(key in value)) {
      out[key] = child
      continue
    }
    out[key] = isPlainObject(child) || Array.isArray(child)
      ? mergeDefaults(value[key], child)
      : coerceLike(value[key], child)
  }
  return out
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text)
  }
  catch {
    return undefined
  }
}

/** 按默认值的类型把原始值掰过来；默认值是 `undefined` 时原样保留（可选字段） */
function coerceLike(raw: unknown, seed: unknown): unknown {
  if (seed === undefined)
    return raw
  if (typeof seed === 'boolean')
    return bool(raw, seed)
  if (typeof seed === 'number')
    return num(raw, seed)
  if (typeof seed === 'string')
    return str(raw, seed)
  if (seed === null)
    return raw ?? null
  return raw
}

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
function parseAddressString(input: string): MailAddress | null {
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

export function normalizeMatchers(raw: unknown): Matcher[] {
  if (!Array.isArray(raw))
    return []
  const out: Matcher[] = []
  for (const item of raw) {
    if (typeof item === 'string') {
      // 允许 UI 只给一个字符串。
      // ⚠ 判据是「以 @ 开头」而不是「含 @」：用户写 `@github.com` 时本意是域名，
      //   而它含 `@` —— 按「含 @ 即邮箱」判会把这条规则变成「匹配发件人地址恰好
      //   等于 @github.com」，即永远不命中。用户的规则会静默失效。
      const value = item.trim().toLowerCase()
      if (!value)
        continue
      if (value.startsWith('@'))
        out.push({ kind: 'domain', value: value.slice(1) })
      else if (value.includes('@'))
        out.push({ kind: 'email', value })
      else
        out.push({ kind: 'domain', value })
      continue
    }
    if (!isPlainObject(item))
      continue
    const value = str(item.value).trim().toLowerCase()
    if (!value)
      continue
    const kind = item.kind === 'email' || item.kind === 'domain' || item.kind === 'regex'
      ? item.kind
      : 'domain'
    // 域名前带 @（`@github.com`）时把 @ 摘掉
    out.push({ kind, value: kind === 'domain' ? value.replace(/^@/, '') : value })
  }
  return dedupeMatchers(out)
}

function dedupeMatchers(matchers: Matcher[]): Matcher[] {
  const seen = new Set<string>()
  return matchers.filter((matcher) => {
    const key = `${matcher.kind}\u0000${matcher.value}`
    if (seen.has(key))
      return false
    seen.add(key)
    return true
  })
}

export function normalizeBlockedList(raw: unknown): BlockedEntry[] {
  return normalizeMatchers(raw)
    .filter((matcher): matcher is BlockedEntry => matcher.kind !== 'regex')
    .map(matcher => ({ kind: matcher.kind, value: matcher.value }))
}

/**
 * 文本行 → 屏蔽项（「批量粘贴」用）。
 *
 * 识别规则（`features/06-blocked-senders.md § 5`）：**以 @ 开头**视为域名，
 * 否则含 `@` 视为邮箱，都不含则视为域名。每行一项，`#` 开头当注释、空行忽略。
 *
 * ⚠ 判据是「以 @ 开头」而不是「含 @」：`@tracker.com` 是用户实际会写的形态
 *   （文档 § 4 的 UI 示例就是它），而它含 `@` —— 按「含 @ 即邮箱」判会把它
 *   变成一个永远不命中的邮箱条目。
 *
 * 非法行（含 `<>` 之类）直接丢弃：把它们原样存进列表的话，用户在 UI 上会看到
 * 一条看起来正常、实际永远不命中的规则，而发现问题只能靠自己逐个核对。
 */
export function parseBlockedListText(text: string): BlockedEntry[] {
  return normalizeBlockedList(
    text
      .split(/[\n,;]+/)
      .map(line => line.trim())
      .filter(line => line && !line.startsWith('#'))
      .filter(line => isLikelyAddressOrDomain(line)),
  )
}

/** 地址 / 域名的粗校验：只允许字母数字、点、连字符、下划线，以及一个 `@` */
function isLikelyAddressOrDomain(value: string): boolean {
  const candidate = value.startsWith('@') ? value.slice(1) : value
  if (!candidate || !/^[\w.-]+$/.test(candidate.replace('@', '')))
    return false
  // 至多一个 @，且不在开头 / 结尾
  const at = candidate.indexOf('@')
  if (at === -1)
    return true
  return at === candidate.lastIndexOf('@') && at > 0 && at < candidate.length - 1
}

// ---------------------------------------------------------------------------
// 账号
// ---------------------------------------------------------------------------

const KNOWN_PROVIDERS: readonly string[] = ['imap', 'gmail', 'outlook', 'eml']

export function normalizeAccount(raw: unknown, fallbackKey?: string): MailAccount | null {
  const value = asObject(raw)
  const id = str(value.id, fallbackKey ?? '')
  if (!id)
    return null

  const provider = str(value.provider, 'imap')
  const config = asObject(value.config)

  return {
    id,
    label: str(value.label) || str(value.email).trim().toLowerCase(),
    // 邮箱一律小写：`by-email` 索引与「按邮箱查账号」都依赖这个规范化。
    // 不做的话，用户填 `Me@Example.COM` 之后按小写查不到自己的账号
    email: str(value.email).trim().toLowerCase(),
    provider: (KNOWN_PROVIDERS.includes(provider) ? provider : 'imap') as MailProviderId,
    config: {
      host: optionalStr(config.host),
      port: config.port === undefined ? undefined : num(config.port, 993),
      tls: config.tls === undefined ? undefined : bool(config.tls, true),
      user: optionalStr(config.user),
      pass: optionalStr(config.pass),
      relayUrl: optionalStr(config.relayUrl),
      clientId: optionalStr(config.clientId),
      refreshToken: optionalStr(config.refreshToken),
      accessToken: optionalStr(config.accessToken),
      expiresAt: config.expiresAt === undefined ? undefined : num(config.expiresAt, 0),
      tenantId: optionalStr(config.tenantId),
    },
    blockedList: normalizeBlockedList(value.blockedList),
    enabled: bool(value.enabled, true),
    createdAt: num(value.createdAt, Date.now()),
    lastSyncedAt: value.lastSyncedAt === undefined ? undefined : num(value.lastSyncedAt, 0),
    lastError: optionalStr(value.lastError),
    cursor: normalizeCursor(value.cursor),
  }
}

function optionalStr(value: unknown): string | undefined {
  if (typeof value !== 'string')
    return undefined
  return value
}

/**
 * 游标归一。
 *
 * 兼容设计文档早期形状：`lastSeenUid` / `uidValidity` 曾经是 `MailAccount` 的
 * **顶层字段**，现在收进 `cursor`。存量数据要把它们搬进去，否则老账号第一次
 * 心跳就会被当成「从未同步过」而重新记游标（丢掉一段增量）。
 */
export function normalizeCursor(raw: unknown, legacy?: { lastSeenUid?: unknown, uidValidity?: unknown }): SyncCursor {
  const value = raw === undefined || raw === null ? {} : asObject(raw)
  const cursor: Record<string, unknown> = {}

  const uid = num(value.uid, Number.NaN)
  if (Number.isFinite(uid))
    cursor.uid = uid

  const uidValidity = num(value.uidValidity, Number.NaN)
  if (Number.isFinite(uidValidity))
    cursor.uidValidity = uidValidity

  if (typeof value.historyId === 'string' && value.historyId)
    cursor.historyId = value.historyId

  // 顶层旧字段迁移
  if (legacy) {
    if (cursor.uid === undefined) {
      const legacyUid = num(legacy.lastSeenUid, Number.NaN)
      if (Number.isFinite(legacyUid))
        cursor.uid = legacyUid
    }
    if (cursor.uidValidity === undefined) {
      const legacyValidity = num(legacy.uidValidity, Number.NaN)
      if (Number.isFinite(legacyValidity))
        cursor.uidValidity = legacyValidity
    }
  }

  return Object.keys(cursor).length > 0 ? cursor : null
}

/** 账号是否「没有游标」（首次同步） */
export function hasNoCursor(account: Pick<MailAccount, 'cursor'>): boolean {
  const cursor = account.cursor
  if (!cursor)
    return true
  return Object.keys(cursor).length === 0
}

// ---------------------------------------------------------------------------
// 规则
// ---------------------------------------------------------------------------

export function normalizeRule(raw: unknown, fallbackKey?: string): PromptRule | null {
  const value = asObject(raw)
  const id = str(value.id, fallbackKey ?? '')
  if (!id)
    return null

  const createdAt = num(value.createdAt, Date.now())

  return {
    id,
    name: str(value.name, '未命名规则'),
    enabled: bool(value.enabled, true),
    priority: num(value.priority, createdAt),
    matchers: normalizeMatchers(value.matchers),
    prompt: str(value.prompt),
    alwaysCopyCode: value.alwaysCopyCode === undefined ? undefined : bool(value.alwaysCopyCode, false),
    alwaysSkipAd: value.alwaysSkipAd === undefined ? undefined : bool(value.alwaysSkipAd, false),
    createdAt,
    updatedAt: num(value.updatedAt, createdAt),
  }
}

/** 内置默认规则不能被存进库（它由 `createDefaultRule()` 现造） */
export function isReservedRuleId(id: string): boolean {
  return id === DEFAULT_RULE_ID
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
    ai: normalizeAiOutput(value.ai),
    copyStatus,
    read: bool(value.read, false),
    dismissed: value.dismissed === undefined ? undefined : bool(value.dismissed, false),
    code: typeof value.code === 'string' && value.code ? value.code : null,
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
 */
function normalizeAiOutput(raw: unknown): AiOutput | undefined {
  if (!isPlainObject(raw))
    return undefined
  const urgency = raw.urgency === 'low' || raw.urgency === 'high' ? raw.urgency : 'normal'
  const code = typeof raw.code === 'string' && raw.code ? raw.code : null
  return {
    minimal: str(raw.minimal),
    summary: str(raw.summary),
    isAd: bool(raw.isAd, false),
    code,
    urgency,
    degraded: raw.degraded === undefined ? undefined : bool(raw.degraded, false),
    error: optionalStr(raw.error),
  }
}

// ---------------------------------------------------------------------------
// 设置
// ---------------------------------------------------------------------------
const RETENTION_VALUES = new Set<string>(MAIL_RETENTION_OPTIONS.map(String))

export function normalizeRetention(raw: unknown, fallback: MailRetention): MailRetention {
  if (raw === 'unlimited')
    return 'unlimited'
  const asText = String(raw)
  if (RETENTION_VALUES.has(asText) && asText !== 'unlimited')
    return Number(asText) as MailRetention
  return fallback
}

export function normalizeAppSettings(raw: unknown): AppSettings {
  const defaults = createDefaultAppSettings()
  const merged = mergeDefaults(raw, defaults)
  return {
    ...merged,
    minimalMode: bool(merged.minimalMode, defaults.minimalMode),
    excludeAds: bool(merged.excludeAds, defaults.excludeAds),
    autoCopyCode: bool(merged.autoCopyCode, defaults.autoCopyCode),
    blockedEnabled: bool(merged.blockedEnabled, defaults.blockedEnabled),
    notifyOnNew: bool(merged.notifyOnNew, defaults.notifyOnNew),
    popupDefaultTab: merged.popupDefaultTab === 'all' || merged.popupDefaultTab === 'code' || merged.popupDefaultTab === 'ad'
      ? merged.popupDefaultTab
      : 'important',
    mailRetention: normalizeRetention(merged.mailRetention, defaults.mailRetention),
    mailRetentionDays: Math.max(0, num(merged.mailRetentionDays, 0)),
    schemaVersion: num(merged.schemaVersion, 1),
  }
}

export function normalizeAiSettings(raw: unknown): AiSettings {
  const defaults = createDefaultAiSettings()
  const merged = mergeDefaults(raw, defaults)
  return {
    platform: str(merged.platform, defaults.platform) || defaults.platform,
    baseUrl: str(merged.baseUrl),
    apiKey: str(merged.apiKey),
    model: str(merged.model),
    maxTokens: Math.max(1, num(merged.maxTokens, 2048)),
    thinking: bool(merged.thinking, false),
    outputLanguage: merged.outputLanguage === 'auto-email' ? 'auto-email' : 'auto-browser',
  }
}
