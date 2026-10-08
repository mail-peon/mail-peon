import { refreshAccessToken } from '~/adapters/mail/providers/gmail/api'

/**
 * Gmail OAuth 授权流程。
 *
 * 用 `chrome.identity.launchWebAuthFlow`（**不是** `getAuthToken`）：
 *
 *   - `getAuthToken` 只对 Chrome 内置的固定 client id 生效，拿不到 `refresh_token`
 *     （它给的是短期 token，SW 休眠重启后就没了），而我们的后台心跳需要长期凭据；
 *   - `launchWebAuthFlow` 用**用户自己的** Google Cloud OAuth Client ID，
 *     走标准 authorization code 流程，能拿到 `refresh_token`。
 *
 * 代价是用户要先在 Google Cloud 建一个 OAuth 客户端（并把它自己的扩展 ID 加进
 * 重定向白名单）。这是设计文档里「不做服务端中转」那条原则的必然结果：
 * 没有服务端就没法托管一个共享的 client secret，只能让用户自带凭据。
 */

/** Google 的授权端点 */
const AUTH_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth'
const SCOPE = 'https://www.googleapis.com/auth/gmail.readonly'

export interface GmailAuthorizeResult {
  ok: boolean
  refreshToken?: string
  email?: string
  error?: string
}

/**
 * 跑一次授权，拿回 `refresh_token`。
 *
 * `chrome.identity.launchWebAuthFlow` 要求 redirect URL 是
 * `https://<extension-id>.chromiumapp.org/` —— 这个域名由浏览器自己接管，
 * 用户的 OAuth 客户端里必须把它加进「已获授权的重定向 URI」。
 */
export async function authorizeGmail(clientId: string): Promise<GmailAuthorizeResult> {
  if (!clientId)
    return { ok: false, error: '请先填写 Google OAuth Client ID' }

  const identity = (globalThis as { browser?: typeof browser }).browser?.identity
  if (!identity?.launchWebAuthFlow)
    return { ok: false, error: '当前浏览器不支持 launchWebAuthFlow，无法完成 Google 授权' }

  try {
    const redirectUri = identity.getRedirectURL()
    const url = new URL(AUTH_ENDPOINT)
    url.searchParams.set('client_id', clientId)
    url.searchParams.set('response_type', 'code')
    url.searchParams.set('redirect_uri', redirectUri)
    url.searchParams.set('scope', SCOPE)
    // `access_type=offline` + `prompt=consent` 缺一不可：
    // 少了 access_type 拿不到 refresh_token；少了 prompt=consent，
    // 用户第二次授权时 Google 会**跳过**同意页、于是也不返回新的 refresh_token
    // （症状是「重新授权后还是失效」，用户完全无从下手）
    url.searchParams.set('access_type', 'offline')
    url.searchParams.set('prompt', 'consent')

    const responseUrl = await identity.launchWebAuthFlow({
      url: url.toString(),
      interactive: true,
    })

    if (!responseUrl)
      return { ok: false, error: '授权被取消' }

    const params = new URL(responseUrl).searchParams
    const error = params.get('error')
    if (error)
      return { ok: false, error: describeAuthError(error) }

    const code = params.get('code')
    if (!code)
      return { ok: false, error: '授权回调里没有 code，请检查 OAuth 客户端的重定向 URI 是否包含扩展地址' }

    return await exchangeCode(clientId, code, redirectUri)
  }
  catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

/**
 * 授权码 → token。
 *
 * ⚠ 这里刻意**不带 `client_secret`**：扩展的源码是公开的，塞一个 secret 进去
 *   等于公开它。Google 对「Chrome 扩展」类型的客户端支持 public client 流程。
 *   如果用户的客户端建成了「Web 应用」类型，这一步会返回
 *   `invalid_client`，下面的错误信息会明确指向这个原因。
 */
async function exchangeCode(clientId: string, code: string, redirectUri: string): Promise<GmailAuthorizeResult> {
  const body = new URLSearchParams({
    client_id: clientId,
    code,
    redirect_uri: redirectUri,
    grant_type: 'authorization_code',
  })

  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  })

  const raw = await res.json().catch(() => null) as {
    refresh_token?: string
    access_token?: string
    error?: string
    error_description?: string
  } | null

  if (!res.ok || !raw?.refresh_token) {
    if (raw?.error === 'invalid_client') {
      return {
        ok: false,
        error: 'Google 拒绝了本次授权（invalid_client）。请确认 OAuth 客户端的类型是「Chrome 扩展」，'
          + '且重定向 URI 里加上了扩展地址',
      }
    }
    const detail = raw?.error_description ?? raw?.error ?? `HTTP ${res.status}`
    /*
     * `refresh_token` 缺失是最常见的坑：用户之前授权过、这次没走 consent 页。
     * 单独给一句能操作的话，而不是把 JSON 原样丢给用户。
     */
    if (!raw?.refresh_token && raw?.access_token) {
      return { ok: false, error: '这次授权没有返回 refresh_token。请到 Google 账号的「第三方应用」里移除本扩展的访问权限后重试' }
    }
    return { ok: false, error: `换取 token 失败：${detail}` }
  }

  return { ok: true, refreshToken: raw.refresh_token }
}

/**
 * 用 refresh token 验证一下「确实能连上」，顺便拿到邮箱地址。
 *
 * 授权完成后立刻验一次的价值：把「授权流程成功了但 token 用不了」这种问题
 * 挡在设置页里，而不是让用户过五分钟发现「收不到邮件」。
 */
export async function verifyGmailAuth(clientId: string, refreshToken: string): Promise<GmailAuthorizeResult> {
  try {
    await refreshAccessToken(clientId, refreshToken)
    return { ok: true, refreshToken }
  }
  catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

function describeAuthError(code: string): string {
  switch (code) {
    case 'access_denied':
      return '授权被拒绝（用户点了取消，或该 Google 账号未被加入测试用户名单）'
    case 'redirect_uri_mismatch':
      return '重定向 URI 不匹配：请把扩展的授权回调地址加进 OAuth 客户端的「已获授权的重定向 URI」'
    case 'invalid_client':
      return 'Client ID 无效：请确认复制完整，且 OAuth 客户端类型是「Chrome 扩展」'
    default:
      return `授权失败：${code}`
  }
}
