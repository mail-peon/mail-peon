import type { MailAccount } from '~/logic/types'
import { requestWithTimeout } from '~/platform/http'

/**
 * Gmail REST API 的最小封装。
 *
 * 为什么这条路能走通而 IMAP 不能：Gmail API 是纯 HTTPS REST，浏览器扩展原生支持；
 * IMAP 需要裸 TCP，MV3 里没有（见 `transport/relay.ts` 的说明）。
 *
 * 三个必须记住的 API 事实：
 *
 * 1. **`format=raw` 给的是完整 RFC822**（base64url 编码）。刻意用它而不是
 *    `format=full`（结构化 payload）：`raw` 能喂给**同一个** `postal-mime` 解析器，
 *    于是 IMAP 与 Gmail 两条路在「原始邮件 → Mail」这一步完全共用代码 ——
 *    两套 payload 解析意味着两套附件/编码/线程头的坑。
 * 2. **`history.list` 只保留约一周**。游标放久了会拿到 404，必须能回退
 *    （见 `fetchSince`），否则用户出差两周回来就永久同步失败。
 * 3. **`history.list` 的 `messagesAdded` 只包含「本次变更涉及的消息」**，
 *    与 `messages.list` 的结果可能不同（前者会漏掉「被移动/改标签」的旧邮件）。
 *    对「新邮件提醒」这个用途来说，`messagesAdded` 正是我们要的。
 */

const OAUTH_TOKEN_URL = 'https://oauth2.googleapis.com/token'
const GMAIL_API = 'https://gmail.googleapis.com/gmail/v1/users/me'

/** 单次请求超时：Gmail 正常毫秒级返回，20s 足够 */
const TIMEOUT_MS = 20_000

/** access token 提前多久算过期（留出时钟漂移与网络往返的余量） */
const TOKEN_EXPIRY_SKEW_MS = 60_000

export class GmailAuthError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'GmailAuthError'
  }
}

export interface GmailMessageStub {
  id: string
  threadId?: string
}

export interface GmailAccessToken {
  token: string
  /** 绝对过期时刻（ts） */
  expiresAt: number
}

/**
 * 用 refresh token 换 access token。
 *
 * ⚠ 扩展的 OAuth 拿不到 `client_secret`（也不该有：它必须公开），所以走
 *   **public client** 流程 —— 不带 `client_secret`，只带 `client_id`。
 *   Google 对已注册为「扩展」类型的客户端支持这种做法。
 */
export async function refreshAccessToken(clientId: string, refreshToken: string): Promise<GmailAccessToken> {
  const body = new URLSearchParams({
    client_id: clientId,
    refresh_token: refreshToken,
    grant_type: 'refresh_token',
  })

  const res = await requestWithTimeout(OAUTH_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  }, TIMEOUT_MS)

  const raw = res.json() as { access_token?: string, expires_in?: number, error?: string, error_description?: string } | null

  if (!res.ok || !raw?.access_token) {
    const detail = raw?.error_description ?? raw?.error ?? `HTTP ${res.status}`
    // `invalid_grant` 是 refresh token 失效（用户撤销授权 / 改过密码 / 太久没用），
    // 这条要单独说清楚：它不是「网络问题」，用户只能重新授权
    if (raw?.error === 'invalid_grant')
      throw new GmailAuthError('Gmail 授权已失效，请重新授权（用户可能撤销了访问权限或改过密码）')
    throw new GmailAuthError(`Gmail 授权失败：${detail}`)
  }

  const expiresIn = typeof raw.expires_in === 'number' ? raw.expires_in : 3600
  return {
    token: raw.access_token,
    expiresAt: Date.now() + expiresIn * 1000 - TOKEN_EXPIRY_SKEW_MS,
  }
}

/**
 * 取一个可用的 access token。
 *
 * `onRefreshed` 让调用方把新 token 写回账号配置 —— 否则每轮心跳都要多一次
 * token 交换往返（Gmail 的 access token 只有 1 小时）。
 */
export async function ensureAccessToken(
  account: MailAccount,
  onRefreshed?: (token: GmailAccessToken) => Promise<void> | void,
): Promise<string> {
  const { accessToken, expiresAt, clientId, refreshToken } = account.config

  if (accessToken && typeof expiresAt === 'number' && expiresAt > Date.now())
    return accessToken

  if (!clientId)
    throw new GmailAuthError('缺少 Google OAuth Client ID')
  if (!refreshToken)
    throw new GmailAuthError('尚未授权 Gmail，请点击「使用 Google 授权」')

  const token = await refreshAccessToken(clientId, refreshToken)
  await onRefreshed?.(token)
  return token.token
}

async function gmailFetch(
  account: MailAccount,
  path: string,
  init: RequestInit = {},
  onRefreshed?: (token: GmailAccessToken) => Promise<void> | void,
): Promise<unknown> {
  const token = await ensureAccessToken(account, onRefreshed)
  const res = await requestWithTimeout(`${GMAIL_API}${path}`, {
    ...init,
    headers: {
      ...init.headers,
      Authorization: `Bearer ${token}`,
      Accept: 'application/json',
    },
  }, TIMEOUT_MS)

  const raw = res.json()
  if (!res.ok) {
    const detail = (raw as { error?: { message?: string } } | null)?.error?.message ?? `HTTP ${res.status}`
    const error = new Error(`Gmail API 失败：${detail}`)
    ;(error as Error & { status?: number }).status = res.status
    throw error
  }
  return raw
}

/** 当前 `historyId`（首次同步的游标） */
export async function getProfile(
  account: MailAccount,
  onRefreshed?: (token: GmailAccessToken) => Promise<void> | void,
): Promise<{ historyId: number, messagesTotal: number, emailAddress: string }> {
  const raw = await gmailFetch(account, '/profile', {}, onRefreshed) as {
    historyId?: string
    messagesTotal?: number
    emailAddress?: string
  } | null

  return {
    historyId: Number.parseInt(raw?.historyId ?? '0', 10) || 0,
    messagesTotal: raw?.messagesTotal ?? 0,
    emailAddress: raw?.emailAddress ?? '',
  }
}

/**
 * 拿 `historyId` 之后新增的邮件 id。
 *
 * `startHistoryId` 太旧（超过 Gmail 的约一周保留窗口）时 API 返回 404 —— 这不是
 * 「账号有问题」，而是「游标过期了」。用专门的 `GmailHistoryExpiredError` 把它
 * 与真正的失败区分开，好让上层走回退路径。
 */
export class GmailHistoryExpiredError extends Error {
  constructor() {
    super('Gmail 增量游标已过期（history 只保留约一周），已回退为按时间拉取')
    this.name = 'GmailHistoryExpiredError'
  }
}

export async function listHistory(
  account: MailAccount,
  startHistoryId: string,
  onRefreshed?: (token: GmailAccessToken) => Promise<void> | void,
): Promise<{ messages: GmailMessageStub[], historyId: string | null }> {
  const messages: GmailMessageStub[] = []
  let pageToken: string | undefined
  let latestHistoryId: string | null = null

  do {
    const params = new URLSearchParams({ startHistoryId, maxResults: '100' })
    if (pageToken)
      params.set('pageToken', pageToken)

    let raw: { history?: Array<{ messagesAdded?: Array<{ message?: GmailMessageStub }> }>, nextPageToken?: string, historyId?: string } | null
    try {
      raw = await gmailFetch(account, `/history?${params.toString()}`, {}, onRefreshed) as typeof raw
    }
    catch (error) {
      if ((error as Error & { status?: number }).status === 404)
        throw new GmailHistoryExpiredError()
      throw error
    }

    for (const entry of raw?.history ?? []) {
      for (const added of entry.messagesAdded ?? []) {
        if (added.message?.id)
          messages.push({ id: added.message.id, threadId: added.message.threadId })
      }
    }

    latestHistoryId = raw?.historyId ?? latestHistoryId
    pageToken = raw?.nextPageToken
  } while (pageToken)

  return { messages, historyId: latestHistoryId }
}

/**
 * 按时间拉邮件 id（history 过期时的回退路径）。
 *
 * 用 `after:<秒>` 而不是 `newer_than:<天>`：后者粒度是天，会把「刚刚已经处理过」
 * 的那批邮件重新拉一遍。时间戳精确到秒，配合上层的去重（账本键是
 * `<accountId>:<messageId>`，重复写只是覆盖）完全够用。
 */
export async function listMessagesAfter(
  account: MailAccount,
  afterMs: number,
  limit: number,
  onRefreshed?: (token: GmailAccessToken) => Promise<void> | void,
): Promise<GmailMessageStub[]> {
  const afterSeconds = Math.max(0, Math.floor(afterMs / 1000))
  const params = new URLSearchParams({
    q: `after:${afterSeconds} in:inbox`,
    maxResults: String(Math.min(Math.max(limit, 1), 500)),
  })

  const raw = await gmailFetch(account, `/messages?${params.toString()}`, {}, onRefreshed) as {
    messages?: GmailMessageStub[]
  } | null

  return raw?.messages ?? []
}

/**
 * 取一封邮件的完整 RFC822（base64url）。
 *
 * `format=raw` 不会把邮件标记为已读（那是 `messages.modify` 的事），
 * 所以后台同步不会影响用户在 Gmail 里的未读状态 —— 这点很重要，
 * 否则「装了个插件之后 Gmail 里全是已读」会立刻被用户发现。
 */
export async function getRawMessage(
  account: MailAccount,
  id: string,
  onRefreshed?: (token: GmailAccessToken) => Promise<void> | void,
): Promise<Uint8Array> {
  const raw = await gmailFetch(account, `/messages/${encodeURIComponent(id)}?format=raw`, {}, onRefreshed) as {
    raw?: string
  } | null

  if (!raw?.raw)
    throw new Error('Gmail 没有返回邮件原文')
  return base64UrlToBytes(raw.raw)
}

/** Gmail 的 `raw` 字段是 base64url（`-` `_` 代替 `+` `/`，且无 padding） */
export function base64UrlToBytes(value: string): Uint8Array {
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/')
  const padded = normalized.padEnd(normalized.length + ((4 - (normalized.length % 4)) % 4), '=')

  const binary = atob(padded)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++)
    bytes[i] = binary.charCodeAt(i)
  return bytes
}

export { GMAIL_API, OAUTH_TOKEN_URL }
