import type { RawData, WebSocket } from 'ws'

/**
 * 一条连接要连的目标。
 *
 * 由 `resolveTarget()` 从 URL 里解析出来，之后**不再变化** ——
 * 所以字段都是 `readonly`：策略检查（token / 白名单）与建连用的是同一份值，
 * 中途被改掉就等于把检查与使用拆开了。
 */
export interface RelayTarget {
  /** 邮件服务器主机名 */
  readonly host: string
  /** 端口 */
  readonly port: number
  /** 是否用 TLS 连接（993 = true） */
  readonly tls: boolean
  /** 请求里带的 token（与 RELAY_TOKEN 比对） */
  readonly token: string
}

/**
 * 「一帧客户端消息」—— `ws` 的 `message` 事件那两个参数的打包。
 *
 * ⚠ 打包成一个对象是**必需**的，不是风格问题：透传路径要把第一帧扣下来
 *   （分流用它），再补投给 `forward`。两个裸参数没法当一个值传递，
 *   而 `forward(null)` 表示「这条连接改用别的模式了，请关掉」。
 */
export interface ClientFrame {
  readonly data: RawData
  readonly isBinary: boolean
}

/**
 * 客户端的 watch 请求 —— 也就是第一帧的 JSON。
 *
 * ⚠ 字段类型**刻意**留成 `unknown`，这不是偷懒：这段 JSON 完全来自网络。
 *   `port` 可能是字符串、`tls` 可能是 `0` / `false`（数字与布尔两种写法都得认，
 *   见 `startWatch` 里 `useTls` 的判定）。`String(...)` / `Number(...)` 就是
 *   「不信任输入」的那一层 —— 不要因为「类型上写着 string」就把它们拆掉。
 */
export interface WatchRequest {
  /** 协议版本标记：只有 `=== 1` 才被当成 watch 请求（见 `onConnection` 的分流） */
  __watch: number
  host?: unknown
  port?: unknown
  tls?: unknown
  user?: unknown
  pass?: unknown
  accountId?: unknown
  token?: unknown
}

/**
 * `watchOnce` 的连接参数。
 *
 * 与 `WatchRequest` 的区别是**可信度**：这些值已经过 `startWatch` 的校验与归一，
 * 所以是真正的 `string` / `number` / `boolean`，可以直接用。
 */
export interface WatchOptions {
  host: string
  port: number
  useTls: boolean
  user: string
  pass: string
  accountId: string
}

/**
 * watch 状态机的位置。
 *
 * ⚠ 只有这五个值：`greeting → login → select → idle ⇄ done`。
 *   区分「现在收到的是哪条命令的响应」全靠它，所以**不要**用裸 `string` ——
 *   打错一个字母（`'Idle'`）会让状态机永远停在原地，而 TS 现在能挡住。
 *   （状态机本身的由来见 `watchOnce` 里 `phase` 变量上的说明。）
 */
export type WatchPhase = 'greeting' | 'login' | 'select' | 'idle' | 'done'

/**
 * 中继推给客户端的 JSON 文本帧。
 *
 * ⚠ 这是**协议**，不是内部数据结构：字段名与 `state` 的取值同时被扩展侧的
 *   watch 客户端消费，改任何一个都是破坏性变更。
 *   `error` / `failed` 的区别是「要不要继续重试」（见 `startWatch`）。
 */
type ClientMessage
  = | { type: 'mail', accountId: string, exists: number }
    | { type: 'state', state: 'watching', exists: number }
    | { type: 'state', state: 'reconnecting', retryInMs: number }
    | { type: 'state', state: 'error' | 'failed', error: string }

/**
 * 第一帧是不是 watch 请求。
 *
 * ⚠ 判据只有 `__watch === 1` 这一条，别的字段一概不看 —— 目标、凭据、token
 *   都在后面各自校验，这里放宽是为了让「字段暂时缺失」的连接走到能给出**具体**
 *   报错的那一层（`watch 请求缺少有效的 host / port`），而不是在分流处就被
 *   当成透传帧写进 TCP。
 *
 * ⚠ 与改动前的 `parsed && parsed.__watch === 1` 等价：JSON 解析出字符串 / 数字
 *   时两者都判为「不是 watch」（原始值上没有 `__watch` 这个属性）。
 */
export function isWatchRequest(value: unknown): value is WatchRequest {
  if (typeof value !== 'object' || value === null)
    return false
  if (!('__watch' in value))
    return false
  return value.__watch === 1
}

/**
 * 给客户端推一条 JSON（文本帧）。
 *
 * ⚠ 只有这里会往 WebSocket 上写「中继 → 扩展」的文本帧，所以上行的协议形状
 *   由 `ClientMessage` 一处定义、一处序列化。
 *
 * ⚠ 检查 `readyState`：连接可能刚好在这一刻关了，`send` 会抛。
 *
 * @param ws 客户端连接
 * @param payload 要推送的消息（形状见 `ClientMessage`）
 */
export function sendToClient(ws: WebSocket, payload: ClientMessage): void {
  if (ws.readyState !== ws.OPEN)
    return
  try {
    ws.send(JSON.stringify(payload))
  }
  catch {
    // 对端刚好断开，忽略
  }
}

/**
 * IMAP 的 quoted string 转义。
 *
 * ⚠ 两件事都必须做对：
 *   1. **转义 `\` 与 `"`**（IMAP 的 quoted string 里这两个是特殊字符）。
 *      注意是 `\\` 匹配单个反斜杠 —— 写成 `/\\/g, '\\\\'` 才对；
 *      一开始写成 `/\\/g, '\\\\'` 的变体把它写成了「转义字母」，是错的。
 *   2. **拒绝 CR/LF**：授权码或密码里出现换行的话，直接拼进命令会变成
 *      命令注入（把后续内容当成新命令发出去）。
 *
 * @param value 原始值（用户名 / 授权码 / token）
 * @returns 带引号、可直接拼进命令行的字符串
 */
export function quote(value: string): string {
  if (/[\r\n]/.test(value))
    throw new Error('凭据里不能包含换行符')
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
}

/**
 * 这个 watch 错误是不是「重试也没用」的那种。
 *
 * ⚠ 判据刻意保守：只有在**确定**是配置 / 凭据问题时才归为致命。
 *   把网络抖动误判成致命 = 用户从此收不到邮件（而且没有明显症状）；
 *   把配置错误误判成可重试 = 只是一串失败日志。
 *   两边的代价不对称，所以宁可多试几次。
 *
 * @param message 错误信息（`Error.message` 归一化后的字符串）
 * @returns true = 重试无用，应停止并让用户改配置
 */
export function isFatalWatchError(message: string): boolean {
  return /登录失败|无法打开收件箱|invalid token|host not allowed|缺少有效的|缺少 user/.test(message)
}

/**
 * 用关闭帧拒绝一条连接。
 *
 * ⚠ 这里有两个坑，都会让**整个中继进程挂掉**（不是只挂这一条连接）：
 *
 * 1. **WebSocket 的关闭原因上限是 123 字节**，超了 `ws.close()` 会直接 `throw`
 *    （`RangeError: The message must not be greater than 123 bytes`）。
 *    而我们这里的文案是中文 + 详细解释，很容易超 —— 实测踩到过一次：
 *    一个非法请求把中继整个打崩，扩展那边表现为「突然所有账号都收不到邮件」。
 * 2. **截断不能按字符切**：随便 `slice(0, 120)` 可能把一个多字节字符切成半个，
 *    编码后字节数反而变了。用 `TextEncoder` 按**字节**截，并用
 *    `{ stream: true }` 解码丢弃残留的半个字符。
 *
 * `ws.close()` 本身也要 try/catch：握手失败（连接还不是 OPEN）时它会抛。
 *
 * @param ws 要拒绝的连接
 * @param error 拒绝原因（可能是 `Error`，也可能是别处抛出来的任意值）
 */
export function reject(ws: WebSocket, error: unknown): void {
  const reason = truncateReason(error instanceof Error ? error.message : String(error))
  try {
    ws.close(1008, reason)
  }
  catch {
    // 连接还没建立或已经关了 —— 直接销毁，反正目的就是断开它
    try {
      ws.terminate()
    }
    catch {}
  }
}

/**
 * 关闭原因最多 123 字节，按字节截断并保证不切坏 UTF-8
 *
 * @param text 原始的关闭原因
 * @returns 不超过 120 字节、且不切坏 UTF-8 的原因串
 */
function truncateReason(text: string): string {
  const bytes = new TextEncoder().encode(text)
  if (bytes.length <= 120)
    return text
  return new TextDecoder('utf-8', { fatal: false }).decode(bytes.slice(0, 120), { stream: true })
}
