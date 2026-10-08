/**
 * mail-peon IMAP 中继 —— WebSocket ↔ 原始 TCP 的**字节透传**隧道。
 *
 * ## 为什么需要它
 *
 * 浏览器扩展里**没有裸 TCP**：MV3 的 Service Worker 只有 `fetch` / `WebSocket`，
 * `chrome.sockets.tcp` 只属于已废弃的 Chrome Apps（第三方扩展拿不到），
 * 而 `imapflow` / `emailjs-imap-client` 依赖 Node 的 `net` / `tls`，在 SW 里直接炸。
 * 于是「IMAP + 用户名密码」这条通用路线必须借一条隧道。
 *
 * ## ⚠️ 中继能看到你的邮箱凭据
 *
 * 这一点必须说清楚，不能含糊：
 *
 * TLS 是**连接的端点行为**，不是线缆上的开关。中继要连上 `imap.x.com:993`
 * （implicit TLS），就必须自己完成 TLS 握手 —— 而握手完成后，那条连接上的
 * **明文就在中继进程里**，包括 `LOGIN` 命令里的用户名与授权码。
 *
 * 所以中继**默认只绑 `127.0.0.1`**：跑在你自己机器上时，「中继能看到凭据」
 * 等于「你自己的电脑能看到凭据」，没有引入任何新的信任方。
 * 把它放到公网（`HOST=0.0.0.0`）之前请先想清楚这件事。
 *
 * 中继不做的事：不解析 IMAP、不记录邮件内容、不落盘、不主动上报。
 *
 * ## 用法
 *
 * ```bash
 * pnpm relay                       # 监听 127.0.0.1:8787
 * TLS_REJECT_UNAUTHORIZED=0 pnpm relay   # 允许自签证书的邮件服务器（仅测试）
 * ```
 *
 * 然后在扩展的「设置 · 账号」里把中继地址填成 `ws://127.0.0.1:8787/`。
 *
 * ## 类型标注
 *
 * 这个文件是 `.mjs`，但要过 `tsc --checkJs`（见 `tsconfig.scripts.json`）。
 * 所以关键位置都写了 JSDoc 类型 —— 不是为了好看，而是因为中继里
 * 「TCP socket 与 WebSocket 的流控语义」太容易写错，而静态检查能挡住
 * `socket.pause` / `ws.pause` 用混这类错误。
 */

import { Buffer } from 'node:buffer'
import { connect as netConnect } from 'node:net'
import process from 'node:process'
import { connect as tlsConnect } from 'node:tls'
import { WebSocketServer } from 'ws'

const PORT = Number.parseInt(process.env.PORT ?? '8787', 10)
const HOST = process.env.HOST ?? '127.0.0.1'

/** 可选：要求 `?token=…` 匹配（放到公网时**必须**设） */
const RELAY_TOKEN = process.env.RELAY_TOKEN ?? ''

/**
 * 可选：逗号分隔的邮件服务器白名单，支持 `*` 通配。
 *
 * 例：`imap.qq.com,*.gmail.com`。空 = 允许任意。
 */
const ALLOWED_HOSTS = (process.env.ALLOWED_HOSTS ?? '')
  .split(',')
  .map(item => item.trim().toLowerCase())
  .filter(Boolean)

/**
 * 是否校验证书链。
 *
 * 默认 **true**。置 0 只应用于「邮件服务器用自签证书」的测试环境 ——
 * 关掉之后中间人攻击不可检出，生产环境不要动它。
 */
const REJECT_UNAUTHORIZED = process.env.TLS_REJECT_UNAUTHORIZED !== '0'

/** 单条连接的空闲超时。IMAP 的 IDLE 会长期静默，所以给得比较宽 */
const IDLE_TIMEOUT_MS = 15 * 60 * 1000

/**
 * 背压阈值：TCP → WebSocket 方向上「已发出但还没 flush 的字节数」上限。
 *
 * 没有它的话，邮箱推得快而 WebSocket 慢时会**无上限堆积**在内存里 ——
 * 日常小邮件看不出问题，收到一封 20MB 附件的邮件时进程内存会瞬间冲上去。
 *
 * 16 MiB 是个宽松值：正常 IMAP 响应远小于它，所以不会误触发暂停；
 * 而它一旦被触发，说明确实有积压，值得付出暂停/恢复的代价。
 */
const HIGH_WATER_BYTES = 16 * 1024 * 1024

/**
 * 一条连接要连的目标。
 *
 * @typedef {object} RelayTarget
 * @property {string} host 邮件服务器主机名
 * @property {number} port 端口
 * @property {boolean} tls 是否用 TLS 连接（993 = true）
 * @property {string} token 请求里带的 token（与 RELAY_TOKEN 比对）
 */

const server = new WebSocketServer({ host: HOST, port: PORT })

server.on('connection', (ws, request) => {
  /** @type {RelayTarget} */
  let target

  try {
    target = resolveTarget(request.url)
  }
  catch (error) {
    reject(ws, error)
    return
  }

  if (RELAY_TOKEN && target.token !== RELAY_TOKEN) {
    log(`拒绝：token 不匹配（${target.host}:${target.port}）`)
    reject(ws, new Error('invalid token'))
    return
  }

  if (ALLOWED_HOSTS.length && !hostAllowed(target.host)) {
    log(`拒绝：${target.host} 不在白名单内`)
    reject(ws, new Error('host not allowed'))
    return
  }

  log(`CONNECT ${target.host}:${target.port}${target.tls ? ' (tls)' : ''}`)

  /*
   * ⚠ 这里是整个中继最关键的一行。
   *
   * 993 端口是 **implicit TLS**：连上立刻握手，握手完成前不接受任何 IMAP 命令。
   * 用裸 `net.connect()` 连上去、把明文的 `A0001 LOGIN ...` 发过去，服务器会看到
   * 一堆不是 ClientHello 的字节 —— 直接关连接，而且日志里看不出原因。
   *
   * `servername` 就是 SNI：共享 IP 的邮件服务器靠它选择证书，
   * 不给的话很多服务器直接拒握手（或回一张不匹配的证书）。
   */
  const socket = target.tls
    ? tlsConnect({
        host: target.host,
        port: target.port,
        servername: isIpLiteral(target.host) ? undefined : target.host,
        rejectUnauthorized: REJECT_UNAUTHORIZED,
      })
    : netConnect({ host: target.host, port: target.port })

  socket.setTimeout(IDLE_TIMEOUT_MS)

  /** 记录「谁先关的」，避免两边互相触发 close 造成重复日志 */
  let closed = false
  /** @param {string} reason */
  const shutdown = (reason) => {
    if (closed)
      return
    closed = true
    log(`CLOSE  ${target.host}:${target.port}（${reason}）`)
    try {
      socket.destroy()
    }
    catch {}
    try {
      ws.close()
    }
    catch {}
  }

  // --- TCP → WebSocket（带背压）------------------------------------------------
  let inFlightBytes = 0
  let tcpPaused = false

  /**
   * 积压降到阈值一半时恢复，避免在阈值附近反复暂停/恢复（抖动）。
   * 抖动本身不算 bug，但每次都会打一行日志，会把真正有用的信息淹掉。
   */
  const RESUME_WATER_BYTES = HIGH_WATER_BYTES / 2

  socket.on('data', (chunk) => {
    if (closed || ws.readyState !== ws.OPEN)
      return

    /*
     * ⚠ `chunk` 在 Node 的类型里是 `Buffer`，但 `net.Socket` 的 data 事件实际给的是
     *   `Buffer`。这里显式转一次 `Buffer.from` 是为了拿到确定的字节长度语义：
     *   一个 `Uint8Array` 可能是更大 buffer 上的视图，而 `chunk.length` 与
     *   `Buffer.byteLength(chunk)` 在那种情况下含义不同。
     */
    const bytes = Buffer.from(chunk)
    inFlightBytes += bytes.length

    // 回调在数据真正写出去之后触发 —— 用它把在途字节数减回去
    ws.send(bytes, () => {
      inFlightBytes = Math.max(0, inFlightBytes - bytes.length)
      if (tcpPaused && inFlightBytes <= RESUME_WATER_BYTES) {
        tcpPaused = false
        socket.resume()
      }
    })

    if (!tcpPaused && inFlightBytes >= HIGH_WATER_BYTES) {
      tcpPaused = true
      socket.pause()
      log(`背压：在途 ${inFlightBytes} 字节，暂停读取（${target.host}）`)
    }
  })

  // --- WebSocket → TCP（带背压）------------------------------------------------
  let wsPaused = false

  ws.on('message', (data, isBinary) => {
    if (closed || socket.destroyed)
      return

    // 二进制帧直接透传；文本帧按 utf8 编码后透传（IMAP 本身是字节协议）。
    // 扩展侧用 `binaryType = 'arraybuffer'` 且只发二进制帧，文本分支是兜底。
    const payload = isBinary
      ? Buffer.from(/** @type {ArrayBuffer} */ (data))
      : Buffer.from(String(data), 'utf8')

    const ok = socket.write(payload)

    /*
     * `write()` 返回 false = 内核 / Node 内部缓冲已满。这时必须暂停 WebSocket 的
     * 接收，否则客户端继续快发会把内存堆起来。
     *
     * ⚠ 不能在 `drain` 之前恢复：`drain` 之后 `write()` 才可能重新返回 true。
     *   这里的 `ws.pause()` / `ws.resume()` 是 ws 库提供的流控（底层是 TCP 的
     *   接收窗口），不是「丢弃消息」—— 消息留在内核缓冲区里。
     */
    if (!ok && !wsPaused) {
      wsPaused = true
      ws.pause()
    }
  })

  socket.on('drain', () => {
    if (wsPaused && !closed) {
      wsPaused = false
      ws.resume()
    }
  })

  // --- 错误 / 关闭 --------------------------------------------------------------
  socket.on('error', (error) => {
    // 证书问题单独说清楚：报 `UNABLE_TO_VERIFY_LEAF_SIGNATURE` 对用户毫无意义
    const code = /** @type {NodeJS.ErrnoException} */ (error).code
    const hint = code === 'UNABLE_TO_VERIFY_LEAF_SIGNATURE'
      || code === 'SELF_SIGNED_CERT_IN_CHAIN'
      || code === 'DEPTH_ZERO_SELF_SIGNED_CERT'
      ? '（邮件服务器用了自签证书；测试环境可设 TLS_REJECT_UNAUTHORIZED=0）'
      : ''
    shutdown(`tcp error: ${code ?? error.message}${hint}`)
  })

  socket.on('timeout', () => {
    shutdown('idle timeout')
  })

  socket.on('close', () => {
    shutdown('tcp closed')
  })

  ws.on('close', () => {
    shutdown('ws closed')
  })

  ws.on('error', (error) => {
    shutdown(`ws error: ${error.message}`)
  })
})

server.on('listening', () => {
  log(`IMAP 中继已启动：ws://${displayHost(HOST)}:${PORT}/`)
  log(`在扩展的账号配置里填：${HOST === '127.0.0.1' ? `ws://127.0.0.1:${PORT}/` : `wss://<你的域名>/`}`)
  if (!REJECT_UNAUTHORIZED)
    log('⚠️  TLS_REJECT_UNAUTHORIZED=0 —— 不校验证书链，仅限测试环境')
  if (HOST !== '127.0.0.1' && HOST !== 'localhost' && HOST !== '::1')
    log('⚠️  正在监听非本机地址：连上来的任何人都能用它连邮件服务器，务必同时设置 RELAY_TOKEN 与 ALLOWED_HOSTS')
  if (!RELAY_TOKEN)
    log('⚠️  未设置 RELAY_TOKEN —— 只应在 127.0.0.1 上使用')
  if (!ALLOWED_HOSTS.length)
    log('⚠️  未设置 ALLOWED_HOSTS —— 允许连任意邮件服务器')
})

/**
 * 解析目标。
 *
 * 支持两种形态（都是扩展侧 `buildRelayUrl` 会产出的）：
 *   - 路径：`/imap.qq.com:993?tls=1`
 *   - 查询：`/tunnel?host=imap.qq.com&port=993&tls=1`
 *
 * @param {string | undefined} rawUrl
 * @returns {RelayTarget} 解析后的目标
 */
function resolveTarget(rawUrl) {
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
    throw new Error('缺少目标 host（用 /host:port 或 ?host=&port=）')

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
 * @param {string} host
 * @returns {boolean} 是否放行
 */
function hostAllowed(host) {
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
 * @param {string} text
 * @returns {string} 正则里的字面量写法
 */
function escapeRegex(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * @param {string} host
 * @returns {boolean} 是否指向本机
 */
function isLoopback(host) {
  return /^(?:localhost|127\.|0\.0\.0\.0|::1$|\[::1\])/i.test(host)
}

/**
 * 纯 IP 字面量不能当 SNI；给了反而会让部分服务器拒握手
 *
 * @param {string} host
 * @returns {boolean} 是否是 IP 字面量
 */
function isIpLiteral(host) {
  return /^\d{1,3}(?:\.\d{1,3}){3}$/.test(host) || host.includes(':')
}

/**
 * @param {string} host
 * @returns {string} 可直接拼进 URL 的主机写法（IPv6 补方括号）
 */
function displayHost(host) {
  return host.includes(':') && !host.startsWith('[') ? `[${host}]` : host
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
 * @param {import('ws').WebSocket} ws
 * @param {unknown} error
 */
function reject(ws, error) {
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
 * @param {string} text
 * @returns {string} 不超过 120 字节、且不切坏 UTF-8 的原因串
 */
function truncateReason(text) {
  const bytes = new TextEncoder().encode(text)
  if (bytes.length <= 120)
    return text
  return new TextDecoder('utf-8', { fatal: false }).decode(bytes.slice(0, 120), { stream: true })
}

/**
 * 最后一道防线：**任何未捕获异常都不该让中继进程退出**。
 *
 * 中继是后台常驻进程，崩了之后用户看到的是「扩展突然连不上」，
 * 而没有任何界面提示他去重启。宁可这一条连接废掉，也不要整个进程没了。
 */
process.on('uncaughtException', (error) => {
  log(`⚠️  未捕获异常（已忽略，进程继续运行）：${error?.stack ?? error}`)
})
process.on('unhandledRejection', (reason) => {
  log(`⚠️  未处理的 Promise 拒绝（已忽略）：${reason instanceof Error ? reason.stack : String(reason)}`)
})

/**
 * @param {string} message
 */
function log(message) {
  process.stdout.write(`[imap-relay] ${new Date().toISOString()} ${message}\n`)
}
