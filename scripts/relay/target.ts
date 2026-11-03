import type { RelayTarget } from './protocol'
import { isLoopback } from './addresses'
import { ALLOWED_HOSTS } from './config'

/**
 * 「这条连接的 URL 里没有目标」。
 *
 * ⚠ 必须与其它解析错误区分开，不能都用 `catch` 一网打尽：
 *
 *   - **没有目标**不是错误 —— watch 请求的 URL 故意不带 `?host=`，目标在第一条
 *     消息的 JSON 里。所以这种连接要**留着**，等第一条消息再决定是 watch 还是
 *     报错。
 *   - **目标非法**（比如 `tls=0` 连 993）是**必须立刻拒绝**的错误。被拒的连接
 *     一个字节都不会发，等消息等于永远不等 —— 那就是「被静默放行」，
 *     安全检查最不该有的失败方式。
 *
 * 一开始把两者混在一个 `catch` 里，结果 `tls=0`+993 被放行了
 * （测试里表现为「关闭码 timeout」）。
 */
export class NoTargetError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'NoTargetError'
  }
}

/**
 * 解析目标。
 *
 * 支持两种形态（都是扩展侧 `buildRelayUrl` 会产出的）：
 *   - 路径：`/imap.qq.com:993?tls=1`
 *   - 查询：`/tunnel?host=imap.qq.com&port=993&tls=1`
 *
 * @param rawUrl 升级请求里的 URL（`request.url`，**故意**可以是 undefined）
 * @returns 解析后的目标
 * @throws NoTargetError URL 里没有目标（调用方应当等第一条消息再决定）
 */
export function resolveTarget(rawUrl: string | undefined): RelayTarget {
  // `new URL` 需要绝对地址；WebSocket 升级请求里给的是相对路径
  const url = new URL(rawUrl ?? '/', 'http://relay.local')

  let host = url.searchParams.get('host') ?? ''
  let port = Number.parseInt(url.searchParams.get('port') ?? '', 10)

  if (!host) {
    const path = decodeURIComponent(url.pathname).replace(/^\/+/, '')
    const match = /^(?:\[([^\]]+)\]|([^:]+))(?::(\d+))?$/.exec(path)
    if (match) {
      host = match[1] ?? match[2] ?? ''
      port = Number.parseInt(match[3] ?? '', 10)
    }
  }

  if (!host)
    throw new NoTargetError('缺少目标 host（用 /host:port 或 ?host=&port=）')

  /*
   * ⚠ `tls` 的判定必须和扩展侧 `MailSocketTarget.tls` 一致。
   *   扩展对 IMAP 的 993 端口默认发 `tls=1`；只有用户显式关掉「使用 TLS」
   *   才会是 `tls=0`（对应 143 端口的明文 IMAP）。
   */
  const tls = url.searchParams.get('tls') !== '0'

  if (!Number.isFinite(port) || port <= 0 || port > 65535)
    port = tls ? 993 : 143

  if (!tls && port === 993) {
    throw new Error('993 端口是 implicit TLS，必须开启 TLS（143 + STARTTLS 本版本不支持）')
  }

  // 防 SSRF 的最低限度：不允许把中继当成「连内网任意端口」的跳板。
  // 完整的防护要靠部署侧的 ALLOWED_HOSTS
  if (isLoopback(host) && !hostAllowed(host))
    throw new Error('拒绝连接本机地址（请显式加进 ALLOWED_HOSTS）')

  return { host, port, tls, token: url.searchParams.get('token') ?? '' }
}

/**
 * 白名单匹配：支持 `*` 通配（如 `*.gmail.com`）
 *
 * @param host 目标主机名（大小写不敏感）
 * @returns 是否放行
 */
export function hostAllowed(host: string): boolean {
  const value = host.toLowerCase()
  return ALLOWED_HOSTS.some((pattern) => {
    if (pattern === value)
      return true
    if (!pattern.includes('*'))
      return false
    // 只把 `*` 当通配，其余字符转义 —— 否则 pattern 里的 `.` 会变成「任意字符」
    const regex = new RegExp(`^${pattern.split('*').map(escapeRegex).join('.*')}$`)
    return regex.test(value)
  })
}

/**
 * @param text 白名单里的一段字面量（`*` 已被 `split` 拆走）
 * @returns 正则里的字面量写法
 */
function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
