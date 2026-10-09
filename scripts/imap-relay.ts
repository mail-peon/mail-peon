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
 * 这个文件是 `.ts`（从 `.mjs` 改名而来），类型直接写在签名上 ——
 * 不是为了好看，而是因为中继里「TCP socket 与 WebSocket 的流控语义」太容易写错，
 * 而静态检查能挡住 `socket.pause` / `ws.pause` 用混这类错误。
 *
 * ⚠ **模块顶层不能写 `await`**：根 `package.json` 没有 `"type": "module"`，
 *   esno（esbuild）会把这个文件编译成 CommonJS，而 CJS 输出格式下 esbuild 直接报
 *   「Top-level await is currently not supported with the "cjs" output format」——
 *   中继**一个字节都不会发**，`pnpm relay` 与冒烟测试全部起不来（实测踩过）。
 *   所以入口逻辑包在下面的 `main()` 里，由末尾的 `void main()` 触发。
 */

import type { IncomingMessage } from 'node:http'
import type { RawData, WebSocket } from 'ws'
import { Buffer } from 'node:buffer'
import { execFileSync } from 'node:child_process'
import { readSync } from 'node:fs'
import { connect as netConnect } from 'node:net'
import process from 'node:process'
import * as readline from 'node:readline'
import { connect as tlsConnect } from 'node:tls'
import { WebSocketServer } from 'ws'

/**
 * 读一个配置项：**命令行参数优先，其次环境变量，最后默认值**。
 *
 * ## 为什么需要命令行参数这一条路
 *
 * 只有环境变量的话，换个端口就得写 `PORT=8788 pnpm relay` —— 那是 **bash 语法**，
 * 在 PowerShell 里会被当成命令名去找，报「术语 'PORT=8788' 不会被识别为 cmdlet」。
 * 而走 `cross-env-shell` 又接不住位置参数
 * （实测 `$npm_config_port` 拿不到值，还附送一条 DEP0190 弃用警告）。
 *
 * 命令行参数三个平台语法**完全一致**，所以它是最省事的那条路：
 * `pnpm relay --port 8788`。
 *
 * ⚠️ 早期这里写的是 `pnpm relay:port 8788`，但 package.json 里**从来没有**那个
 *   script（`relay:port-test` 是测试，不是传参入口）。照文档敲会直接报
 *   「Missing script」，所以别把它当成存在的命令。
 *
 * 环境变量保留不变 —— 后台服务形态（见 `relay-deployment.md`）就是靠它注入配置的。
 *
 * @param flag 命令行标记名（不含前导 `--`）
 * @param envName 环境变量名
 * @param fallback 默认值
 * @returns 生效的配置值
 */
function readOption(flag: string, envName: string, fallback: string): string {
  const index = process.argv.indexOf(`--${flag}`)
  if (index >= 0 && process.argv[index + 1] !== undefined)
    return process.argv[index + 1]
  return process.env[envName] ?? fallback
}

/** 端口。`--port 8788` / `PORT=8788` / 默认 8787 */
const PORT_RAW = readOption('port', 'PORT', '8787')
const PORT = Number.parseInt(PORT_RAW, 10)

/*
 * ⚠ 端口必须在启动**之前**校验。
 *
 * 交给 `new WebSocketServer({ port: NaN })` 的后果不是一条清晰的报错，而是
 * `options.port should be >= 0 and < 65536` 加上一个 **unhandled 'error' event**
 * 把进程打崩 —— 用户看到的是 Node 的堆栈，而不是「你端口写错了」。
 */
if (!Number.isInteger(PORT) || PORT < 0 || PORT > 65535) {
  process.stderr.write(`[imap-relay] 端口无效：「${PORT_RAW}」（应为 0–65535 的整数）\n`)
  process.exit(1)
}

/** 监听地址。默认只绑本机 —— 中继能看到邮箱密码，不该默认对外 */
const HOST = readOption('host', 'HOST', '127.0.0.1')

/** 可选：要求 `?token=…` 匹配（放到公网时**必须**设） */
const RELAY_TOKEN = readOption('token', 'RELAY_TOKEN', '')

/**
 * 可选：逗号分隔的邮件服务器白名单，支持 `*` 通配。
 *
 * 例：`imap.qq.com,*.gmail.com`。空 = 允许任意。
 */
const ALLOWED_HOSTS = readOption('allow-hosts', 'ALLOWED_HOSTS', '')
  .split(',')
  .map(item => item.trim().toLowerCase())
  .filter(Boolean)

/**
 * 是否校验证书链。
 *
 * 默认 **true**。置 0 只应用于「邮件服务器用自签证书」的测试环境 ——
 * 关掉之后中间人攻击不可检出，生产环境不要动它。
 */
const REJECT_UNAUTHORIZED = readOption('tls-reject-unauthorized', 'TLS_REJECT_UNAUTHORIZED', '1') !== '0'

/**
 * 是否把每条连接上的**字节**打到终端（`RELAY_TRACE=1`）。
 *
 * ⚠ 默认关闭，而且**不是**「为了少打日志」：IMAP 的往返里包含用户的
 *   `LOGIN` 命令（含授权码）与邮件正文。默认开着等于把凭据写进终端回滚缓冲、
 *   shell 历史、以及任何录屏里。
 *
 * 它的用途只有一个：真机上出现「CONNECT 之后很快 CLOSE、且看不出原因」时，
 * 打开它就能看到到底走到哪一步 —— 是 TLS 没握完、LOGIN 被拒、还是命令发出去
 * 之后服务器直接关了连接。现有日志只记录连接的开合，那三种情况长得一模一样。
 */
const TRACE = process.env.RELAY_TRACE === '1'

/**
 * 常驻监听（watch）模式下，重发 `IDLE` 的间隔。
 *
 * RFC 2177 建议客户端的 IDLE 不要超过 **29 分钟** —— 多数服务器会在 30 分钟时
 * 主动断开空闲连接。这里取 25 分钟留出余量。
 *
 * （QQ 实测在 IDLE 下会持续推 `* n EXISTS`，没有出现过到点断开；
 *   但这是协议建议，不能赌某个服务器一直容忍。）
 */
const WATCH_REIDLE_MS = 25 * 60 * 1000

/**
 * 断开后重连的退避阶梯（毫秒）。
 *
 * 先快后慢：如果是网络抖动，几秒就能恢复；如果是密码错 / 被限流，
 * 快速重试只会让情况更糟（QQ 会因为频繁建连直接拒连），所以逐级拉长到 5 分钟。
 */
const WATCH_RETRY_DELAYS_MS = [2000, 5000, 15000, 30000, 60000, 120000, 300000]

/** 单条连接的空闲超时。IMAP 的 IDLE 会长期静默，所以给得比较宽 */
const IDLE_TIMEOUT_MS = 15 * 60 * 1000

/**
 * 带**行边界保护**的字节缓冲区。
 *
 * ⚠ 这一层是必需的，不是过度设计：TLS 分片**会在任意字节位置切开一行**。
 *   `read()` 返回的可能是半行、也可能是三行半。直接把每段当整行解析，
 *   会在「`* 12 EXISTS` 被切成 `* 12 EX` + `ISTS`」时解析出垃圾 ——
 *   而症状是「偶尔漏掉一封邮件」，几乎无法复现。
 *
 * 与扩展侧 `ImapClient` 里那份是同一个设计；中继是独立进程、不能 import
 * 扩展的 TS 代码，所以这里必须有一份自己的。（这重复是刻意的：
 * 中继要保持「零依赖、可直接 node 跑」。）
 */
class LineBuffer {
  /**
   * 还没被切出完整行的字节。
   *
   * ⚠ 类型是 `Buffer` 而不是 `Uint8Array`：`subarray()` 与 `indexOf('\r\n')`
   *   这两个用法都依赖 Buffer 的成员，而 `next()` 返回的是**视图**（不复制），
   *   所以这里必须一直持有可能比视图形状更宽的原始缓冲。
   */
  pending: Buffer

  constructor() {
    this.pending = Buffer.alloc(0)
  }

  /** @param chunk 刚收到的一段字节（可能在某一行中间被切开） */
  push(chunk: Buffer): void {
    this.pending = this.pending.length ? Buffer.concat([this.pending, chunk]) : chunk
  }

  /**
   * 取下一行（不含 CRLF）。
   *
   * @returns 没有完整行时返回 null
   */
  next(): string | null {
    const index = this.pending.indexOf('\r\n')
    if (index === -1)
      return null
    const line = this.pending.subarray(0, index).toString('utf8')
    this.pending = this.pending.subarray(index + 2)
    return line
  }

  /** 丢掉缓冲（重连时用 —— 上一个连接的半个响应不能带到新连接里） */
  reset(): void {
    this.pending = Buffer.alloc(0)
  }
}

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
 * 由 `resolveTarget()` 从 URL 里解析出来，之后**不再变化** ——
 * 所以字段都是 `readonly`：策略检查（token / 白名单）与建连用的是同一份值，
 * 中途被改掉就等于把检查与使用拆开了。
 */
interface RelayTarget {
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
interface ClientFrame {
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
interface WatchRequest {
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
interface WatchOptions {
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
type WatchPhase = 'greeting' | 'login' | 'select' | 'idle' | 'done'

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
function isWatchRequest(value: unknown): value is WatchRequest {
  if (typeof value !== 'object' || value === null)
    return false
  if (!('__watch' in value))
    return false
  return value.__watch === 1
}

/**
 * 中继服务的启停句柄。
 *
 * ⚠ 做成「工厂 + 显式启停」而不是模块加载时就 `listen`：这样 `r`（重启）
 *   才有一个干净的对象可以关掉重建。模块顶层直接监听的话，重启只能靠
 *   `process.exit` 让外部（pm2 之类）拉起来 —— 而交互式控制台里没有那个外部。
 */
interface RelayServer {
  /** 开始监听。端口被占用 / 服务错误时 reject */
  start: () => Promise<void>
  /** 停止监听，并**主动**断开所有活着的连接（否则 IMAP 的 IDLE 会把重启卡住） */
  stop: () => Promise<void>
  /** 扩展里该填的地址 */
  url: () => string
}

/**
 * 建立中继的 WebSocket 服务。
 *
 * @returns 中继服务的启停句柄
 */
function createRelayServer(): RelayServer {
  /**
   * 当前的服务对象。
   *
   * ⚠ 可能非空但**没在监听**（上一次失败尝试留下的残留，见下面 `listening`），
   *   所以判断「是否在跑」永远要用 `listening`，不要用 `server !== null`。
   */
  let server: WebSocketServer | null = null

  /**
   * 「当前真的在监听」。
   *
   * ⚠ 不能拿 `server !== null` 当这个判断 —— 那正是修之前的一个真 bug：
   *
   *   端口被占用时 `new WebSocketServer(...)` 已经建了对象、`server` 也被赋了值，
   *   然后 `error` 事件（EADDRINUSE）让 `start()` 抛出。**但 `server` 没有被清回去**，
   *   于是「杀掉占用者之后再 start()」会在第一行 `if (server) return` 处直接返回：
   *   监听确实成功了（那个对象自己还在监听），但 `logListening()` 永远不会执行 ——
   *   用户看到的是「已结束 PID xxx」之后**没有**启动日志，只有一个控制台提示。
   *
   *   所以用一个只在 `listening` 之后才置位的标志，并且失败时把残留对象清掉。
   */
  let listening = false

  /** 当前活着的连接（重启时要主动断掉它们） */
  const connections = new Set<WebSocket>()

  async function start(): Promise<void> {
    if (listening)
      return

    /*
     * 上一次尝试失败时残留的对象：先彻底丢掉它。
     *
     * 走到这里说明 `listening` 是 false，但 `server` 可能非空（失败的尝试留下的）。
     * 不清理的话它会一直挂着一个坏掉的监听器。
     */
    if (server) {
      const stale = server
      server = null
      try {
        stale.close()
      }
      catch {}
    }

    /*
     * ⚠ 赋给局部 const 再用：`server` 是可变绑定，TS 在 `await` 之后会**丢掉收窄**
     *   （闭包可能在赋值之后再执行），于是 `server.once(...)` 报「可能是 null」。
     *   用局部 const 把收窄固定下来，顺便让这段读起来也更清楚。
     */
    const created = new WebSocketServer({ host: HOST, port: PORT })
    server = created

    created.on('connection', onConnection)
    connections.clear()

    try {
      await new Promise<void>((resolve, reject) => {
        /*
         * ⚠ 两个 handler **互不引用**，靠一个 `settled` 标志去重。
         *
         *   互相 `off()` 的写法（`onError` 里摘 `onListening`、反之亦然）会让
         *   「谁先声明」变成必须推理的事，而 `no-use-before-define` 会直接拦下来。
         *   用 `once` + 标志位更简单，也不依赖声明顺序。
         */
        let settled = false
        const onListening = () => {
          if (settled)
            return
          settled = true
          // ⚠ 保留显式实参：`Promise<void>` 的 resolve 接受 `undefined`，
          //   而这里要的是「与改动前一模一样的那次调用」，不要顺手写成 `resolve()`
          resolve(undefined)
        }
        const onError = (error: Error) => {
          if (settled)
            return
          settled = true
          reject(error)
        }
        // `once` 保证两个监听器各自最多触发一次，且触发后自动摘除
        created.once('listening', onListening)
        created.once('error', onError)
      })
    }
    catch (error) {
      /*
       * ⚠ 失败时**必须**清掉残留：留着它会让下一次 `start()` 误以为「已经在跑了」。
       *   见上面 `listening` 的说明。
       */
      if (server === created)
        server = null
      try {
        created.close()
      }
      catch {}
      throw error
    }

    listening = true

    created.on('error', (error) => {
      // 运行期错误不该让进程退出（`uncaughtException` 兜底也覆盖不到 EventEmitter）
      log(`⚠️  服务错误（已忽略，进程继续运行）：${error.message}`)
    })

    logListening()
  }

  async function stop(): Promise<void> {
    const current = server
    // ⚠ 用 `listening` 而不是 `server`：失败的尝试会留下一个非空但没在监听的
    //   对象（见 `listening` 的说明），那种情况下没有什么可关的
    if (!current || !listening)
      return
    server = null
    listening = false

    /*
     * 顺序很重要：先主动断开所有连接，再 `close()`。
     *
     * `ws` 的 `server.close()` 会**等现有连接自己结束**，而 IMAP 连接可以空闲挂
     * 十几分钟（IDLE 超时就是 15 分钟）—— 不主动断的话，「重启」会卡在那里，
     * 用户看到的是「敲了 r 但没反应」。
     */
    for (const ws of connections) {
      try {
        ws.close(1001, 'relay restarting')
      }
      catch {}
    }
    connections.clear()

    await new Promise<void>((resolve) => {
      current.close(() => resolve(undefined))
      // 兜底：某些环境下 close 回调可能不来
      setTimeout(resolve, 2000)
    })
  }

  /**
   * 连接进来：**先看第一条消息**决定这条连接是哪种中继。
   *
   * 两种用法共用同一个 WebSocket 端点，靠第一帧区分：
   *
   * | | 第一帧 | 用途 |
   * | --- | --- | --- |
   * | **透传** | 二进制（IMAP 命令） | 插件抓取时建立一次，用完就关 |
   * | **watch** | 文本 JSON（`__watch: 1`） | 常驻，中继替插件挂 `IDLE` 并推新邮件 |
   *
   * ## ⚠ 两个必须避开的坑（都真机上踩过）
   *
   * **① 建 TCP 必须是「立刻」，不能等到第一条消息。**
   * 有些真实用法（以及证书校验这类测试）**一个字节都不发**，只是等中继去连、
   * 然后观察结果 —— 不管是「TLS 握手失败被关掉」还是「服务器先说话」。
   * 把连接推迟到收帧之后，它们就永远等不到结果，表现成「卡住」。
   *
   * **② 分流必须在**建 TCP 之后、**转发之前**做。**
   * watch 请求是**文本 JSON**，而透传路径会把任何帧原样写进 TCP ——
   * 顺序错了就会把 watch 的 JSON 当成 IMAP 命令发给邮件服务器。
   * 所以第一条消息由这里拦截判断，判断为 watch 时**先关掉刚建的 TCP** 再走 watch。
   * （代价是 watch 会在邮件服务器上留下一条「连上就断」的记录，而服务器
   *   一个字节都没收到 —— 它看不到任何命令，这是可接受的。）
   *
   * **③ 不要用「`once('message')` 置标志 + `setImmediate` 判断」分流。**
   * 那是**结构性竞态**：`setImmediate` 在轮询阶段结束时就跑，而 WebSocket 的帧解析
   * 是异步的 —— 消息还没派发，判断已经做了。于是连接被同时当成两种中继：
   * watch 的 JSON 被当成 IMAP 命令发出去，透传路径又因为 URL 里没有 `?host=`
   * 直接 `close(1008)`。症状是「客户端一条消息都收不到」，日志里只有一条 1008。
   *
   * **④ 策略检查必须**同步做。**
   * 被拒的连接（白名单外、`tls=0` + 993）不发任何字节，任何「等消息再决定」的
   * 写法都会让它们一直挂着 —— 那是「被静默放行」，安全检查最不该有的失败方式。
   *
   * 不使用 `ws.pause()` / `resume()` 做分流：ws 的流控与背压逻辑共用同一个状态，
   * 在连接初期介入会和 `startPassthrough` 里的 `wsPaused` 打架（实测字节全丢）。
   *
   * @param ws 刚升级完成的 WebSocket 连接
   * @param request 升级请求（只看 `url`：目标与 token 都在 query / path 里）
   */
  function onConnection(ws: WebSocket, request: IncomingMessage): void {
    connections.add(ws)
    ws.on('close', () => connections.delete(ws))

    /**
     * 解析目标。`null` = **这个 URL 里没有目标**，也就是「还判断不出这是哪种连接」。
     *
     * ⚠ 这个区分很关键：watch 请求的 URL **故意不带** `?host=` ——
     *   目标在第一条消息的 JSON 里。所以「URL 里没有目标」不能直接当成错误拒掉，
     *   否则 watch 连接会在发出请求之前就被 `close(1008)`，
     *   而症状是**客户端一条消息都收不到**（看起来像中继没工作）。
     */
    let target: RelayTarget | null = null
    try {
      target = resolveTarget(request.url)
    }
    catch (error) {
      /*
       * ⚠ 只有「URL 里没有目标」才留着等第一条消息（见 `NoTargetError` 的说明）。
       *   其它解析错误（`tls=0` 连 993、本机地址不在白名单…）必须**立刻拒绝** ——
       *   被拒的连接不发任何字节，等消息等于永远不等，那就是「被静默放行」。
       */
      if (!(error instanceof NoTargetError)) {
        reject(ws, error)
        return
      }
      target = null
    }

    /**
     * 透传路径的「转发这一帧」入口。
     *
     * ⚠ 用 `let` 而不是 `const`：URL 里没有目标时它**还没被创建**
     *   （那种连接可能是 watch，要等第一条消息才知道）。
     */
    let forward: ((frame: ClientFrame | null) => void) | null = null

    /** 有目标时才做策略检查；没有目标的连接要等第一条消息 */
    if (target) {
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

      /*
       * 先把 TCP/TLS 建起来（说明 ①），再挂上分流。
       *
       * `startPassthrough` 返回一个「转发这一帧」的函数 —— 分流判断为透传时
       * 把第一帧交给它（说明 ②：那一帧被 `once('message')` 消耗掉了，
       * 不补投的话客户端的第一个 IMAP 命令就丢了，服务器一直等不到命令）。
       */
      forward = startPassthrough(ws, target, (error) => {
        // `null` = 连接建立成功；只有失败时才记日志
        if (error)
          log(`CONNECT ${target.host}:${target.port} 失败：${error.message}`)
      })
      if (!forward)
        return
    }

    ws.once('message', (data, isBinary) => {
      if (!isBinary) {
        /*
         * ⚠ 先落成 `unknown` 再判断：这段 JSON **完全来自网络**，
         *   把 `JSON.parse` 的结果直接当对象用，等于让「客户端发了个数字」
         *   这种输入一路穿到下面的属性读取。判断由 `isWatchRequest` 负责。
         */
        let parsed: unknown = null
        try {
          parsed = JSON.parse(data.toString())
        }
        catch {
          parsed = null
        }

        if (isWatchRequest(parsed)) {
          // 这条连接是 watch —— 把刚建的透传连接关掉（说明 ②）
          forward?.(null)
          /*
           * ⚠ 形参标 `Error` 是**准确**的，不是为了让报错消失：`startWatch` 里所有
           *   失败路径都是 `throw new Error(...)` / `reject(new Error(...))`。
           *   必须显式标注的原因在 `Promise.catch` 的签名上 —— 它的形参是 `any`，
           *   不标就等于这里没有类型（而 `error.message` 的语义与改动前一致）。
           */
          startWatch(ws, parsed).catch((error: Error) => {
            log(`watch 启动失败：${error.message}`)
            sendToClient(ws, { type: 'state', state: 'failed', error: error.message })
            try {
              ws.close(1011, 'watch failed')
            }
            catch {}
          })
          return
        }
      }

      /*
       * 走到这里说明它不是 watch 请求。
       *
       * 如果 URL 里本来就没有目标（`target === null`），那这条连接既没有目标
       * 也不是 watch —— 现在才报错。这时报是安全的：watch 已经排除了，
       * 而透传连接本来就会立刻发第一条命令，用户不会白等。
       */
      if (!target) {
        reject(ws, new Error('缺少目标 host（用 /host:port 或 ?host=&port=）'))
        return
      }

      forward?.({ data, isBinary })
    })
  }

  /**
   * 普通中继：把 WebSocket 的字节透传进 TCP。
   *
   * ⚠ **立刻建连接**，不等第一条消息 —— 有些用法一个字节都不发，只是等中继去连
   *   （见 `onConnection` 的说明 ①）。
   *
   * @param ws 客户端连接
   * @param target 已经过策略检查的目标
   * @param onConnectError 连接建立失败时回调（`null` = 成功）
   * @returns 转发一帧的函数；传 `null` 表示「这条连接改用别的模式了，请关掉」。
   *   WebSocket 已经不在 OPEN 状态时返回 `null`（调用方应当直接放弃）。
   */
  function startPassthrough(
    ws: WebSocket,
    target: RelayTarget,
    onConnectError: (error: Error | null) => void,
  ): ((frame: ClientFrame | null) => void) | null {
    if (ws.readyState !== ws.OPEN)
      return null

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
    /** @param reason 关闭原因（只进日志） */
    const shutdown = (reason: string): void => {
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
      trace('←', bytes)
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

    /**
     * 转发一帧：写进 TCP。传 `null` 表示「改用别的模式了，把这条连接关掉」。
     *
     * @param frame 客户端的一帧；`null` = 改用 watch 模式
     */
    const forward = (frame: ClientFrame | null): void => {
      if (frame === null) {
        shutdown('改用 watch 模式')
        return
      }
      if (closed || socket.destroyed)
        return

      const { data, isBinary } = frame

      /*
       * 二进制帧直接透传；文本帧按 utf8 编码后透传（IMAP 本身是字节协议）。
       * 扩展侧用 `binaryType = 'arraybuffer'` 且只发二进制帧，文本分支是兜底。
       *
       * ⚠ `data as ArrayBuffer` 只是把 `RawData`（`Buffer | ArrayBuffer | Buffer[]`）
       *   缩到「扩展侧实际会发的那一种」；运行时 `Buffer.from` 仍然按**实参的真实类型**
       *   分派（`Buffer.from(Buffer)` 同样是复制字节），所以行为与改动前完全一致。
       */
      const payload = isBinary
        ? Buffer.from(data as ArrayBuffer)
        : Buffer.from(String(data), 'utf8')

      trace('→', payload)

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
    }

    /// 分流之后由 `onConnection` 调用的转发入口（它拿到的是 `{data, isBinary}`）
    /** @param frame 客户端的一帧；`null` = 改用 watch 模式 */
    const forwardFrame = (frame: ClientFrame | null): void => forward(frame)

    /**
     * 注册「从第二帧起」的转发。
     *
     * ⚠ 由 `onConnection` 在分流完成**之后**调用，不能在这里立刻注册。
     *
     *   第一帧由 `onConnection` 的 `once('message')` 读走用于分流，再由它调
     *   `forwardFrame` 补投。如果这个 `ws.on('message')` 从一开始就挂着，
     *   第一帧会被处理**两次** —— 实测症状是「回声测试收到 84 字节，期望 42」。
     */
    const startForwarding = (): void => {
      ws.on('message', (data, isBinary) => {
        forward({ data, isBinary })
      })
    }

    socket.on('connect', () => {
      // 纯 TCP：连上就算成功
      if (!target.tls)
        onConnectError(null)
    })

    socket.on('drain', () => {
      if (wsPaused && !closed) {
        wsPaused = false
        ws.resume()
      }
    })

    // --- 错误 / 关闭 --------------------------------------------------------------
    socket.on('error', (error) => {
      /*
       * 证书问题单独说清楚：报 `UNABLE_TO_VERIFY_LEAF_SIGNATURE` 对用户毫无意义。
       *
       * ⚠ 断言成 `NodeJS.ErrnoException` 是必要的：socket 的错误在运行期**一定**
       *   带 `code`（`ECONNREFUSED` / `CERT_HAS_EXPIRED` …），而 `Error` 类型上
       *   没有这个属性。这里读的是 Node 自己写的字段，不是我们在猜。
       */
      const code = (error as NodeJS.ErrnoException).code
      const hint = code === 'UNABLE_TO_VERIFY_LEAF_SIGNATURE'
        || code === 'SELF_SIGNED_CERT_IN_CHAIN'
        || code === 'DEPTH_ZERO_SELF_SIGNED_CERT'
        ? '（邮件服务器用了自签证书；测试环境可设 TLS_REJECT_UNAUTHORIZED=0）'
        : ''

      /*
       * 只有在**连接还没建立**时才算「建连失败」。
       *
       * 判断依据是 `socket.connecting`（Node 的标准属性）：连接建立之后的错误
       * （比如服务器中途 RST）不该再报给分流逻辑 —— 那时已经没有「要不要分流」
       * 这回事了。
       */
      if (socket.connecting)
        onConnectError(new Error(`${code ?? error.message}${hint}`))

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

    /**
     * 分流完成后由 `onConnection` 调用的入口：先挂上后续帧的转发，再补投第一帧。
     *
     * @param frame 被分流扣下的第一帧；`null` = 改用 watch 模式
     */
    const accept = (frame: ClientFrame | null): void => {
      // 分流完成，从这一刻起后续帧都按透传处理
      startForwarding()
      forwardFrame(frame)
    }

    return accept
  }

  /**
   * 常驻监听：替插件挂住 IMAP `IDLE`，有新邮件就推一行过去。
   *
   * ## 为什么这件事必须由中继做
   *
   * MV3 的 Service Worker 空闲约 30 秒就被回收，插件侧挂不住长连接
   * （`setInterval` 与常驻 WebSocket 都保不住）。中继是普通 Node 进程，
   * 可以一直挂着 `IDLE`。而这不扩大信任面 —— 中继为了通 TLS 本来就要终止握手、
   * 看得到明文（包括邮箱密码）。
   *
   * ## 只认 EXISTS 变大
   *
   * 不看 `RECENT`：RFC 里它的语义是「本次会话期间到达的邮件数」，各服务器实现
   * 差别很大（QQ 在 `SELECT` 时经常直接给 `* 0 RECENT`，哪怕明明有新邮件）。
   * `EXISTS`（邮箱现在共有多少封）语义干净且一致。
   *
   * 基准值取 `SELECT` 那一刻的 `EXISTS`：这样「插件连上之前刚到的那封」不会被
   * 误判。而它本来也不会丢 —— 插件被推醒后做的是正常的增量抓取，抓的是
   * **游标之后的所有邮件**，不依赖推送里带的数字。
   *
   * ## 推送里不带邮件内容
   *
   * 只带「有新邮件了」这个事实。理由有两条：
   *   1. 插件侧只需要**一条**抓取代码路径（推送 / 手动 / 兜底定时器共用），
   *      多一条「推送专用抓取」的路就是多一个「只有推送时才复现」的 bug 温床；
   *   2. 中继不必解析邮件。它对内容的了解**仅限**「有几封」——
   *      中继越笨，它出问题时的破坏面越小。
   *
   * @param ws 客户端连接
   * @param request 客户端的 watch 请求
   */
  async function startWatch(ws: WebSocket, request: WatchRequest): Promise<void> {
    const host = String(request.host ?? '')
    const port = Number(request.port)
    const useTls = request.tls !== false && request.tls !== 0
    const user = String(request.user ?? '')
    const pass = String(request.pass ?? '')
    const accountId = String(request.accountId ?? 'unknown')

    if (!host || !Number.isInteger(port) || port <= 0 || port > 65535)
      throw new Error('watch 请求缺少有效的 host / port')
    if (!user || !pass)
      throw new Error('watch 请求缺少 user / pass')

    // 和普通中继连接共用同一套访问控制 —— 白名单不能只在透传路径上生效
    if (RELAY_TOKEN && String(request.token ?? '') !== RELAY_TOKEN)
      throw new Error('invalid token')
    if (ALLOWED_HOSTS.length && !hostAllowed(host))
      throw new Error(`host not allowed: ${host}`)

    /** 客户端主动断开了？用于让重连循环停下来 */
    let clientGone = false
    ws.on('close', () => {
      clientGone = true
    })
    ws.on('error', () => {
      clientGone = true
    })

    log(`WATCH ${host}:${port} (${accountId}) 开始常驻监听`)

    let attempt = 0
    /*
     * ⚠ 循环条件是 `clientGone`，而它由 `ws` 的事件回调修改 ——
     *   eslint 的 `no-unmodified-loop-condition` 看不到跨回调的写入，会误报。
     *   改成 `for (;;)` + 显式 break 更诚实：这个循环的出口就是「客户端走了」。
     */
    for (;;) {
      if (clientGone)
        break

      try {
        await watchOnce(ws, { host, port, useTls, user, pass, accountId })
        // 正常返回 = 服务器关了连接，退避后重连
        attempt = 0
      }
      catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        log(`WATCH ${host}:${port} 断开：${message}`)
        sendToClient(ws, { type: 'state', state: 'error', error: message })

        /*
         * 认证 / 配置类错误**不重试**。
         *
         * 密码错或被拒时快速重连只会让服务器把账号锁掉（QQ 会直接拒连一段时间），
         * 而用户看到的是一串无意义的失败日志。这类错误交给插件在界面上提示用户
         * 去改配置 —— 改完他会重新触发 watch。
         */
        if (isFatalWatchError(message)) {
          log(`WATCH ${host}:${port} 停止重试（需要用户修正配置）`)
          sendToClient(ws, { type: 'state', state: 'failed', error: message })
          break
        }
      }

      if (clientGone)
        break

      const delay = WATCH_RETRY_DELAYS_MS[Math.min(attempt, WATCH_RETRY_DELAYS_MS.length - 1)]
      attempt++
      sendToClient(ws, { type: 'state', state: 'reconnecting', retryInMs: delay })
      await sleep(delay)
    }

    log(`WATCH ${host}:${port} (${accountId}) 结束`)
  }

  /**
   * 挂一次 `IDLE`，直到连接断开。
   *
   * @param ws 客户端连接（有新邮件时往这里推）
   * @param options 已经校验并归一过的连接参数
   * @returns 连接结束时 resolve
   */
  function watchOnce(ws: WebSocket, options: WatchOptions): Promise<void> {
    const { host, port, useTls, user, pass, accountId } = options

    /*
     * ⚠ `Promise<void>` 的显式类型参数是必需的：不给的话 `Promise<unknown>`，
     *   而 `finish()` 里那条不成功的路径按设计是 `resolve()`（无参）——
     *   那就成了「Expected 1 arguments, but got 0」。
     */
    return new Promise<void>((resolve, reject) => {
      const socket = useTls
        ? tlsConnect({
            host,
            port,
            servername: isIpLiteral(host) ? undefined : host,
            rejectUnauthorized: REJECT_UNAUTHORIZED,
          })
        : netConnect({ host, port })

      /*
       * ⚠ IDLE 会长期静默（可能几十分钟没有任何字节），所以**不能**沿用普通连接的
       *   15 分钟空闲超时 —— 那会把一条健康的连接当成超时踢掉。
       */
      socket.setTimeout(0)

      const lines = new LineBuffer()
      let done = false

      /*
       * ⚠ `reidleTimer` 必须在 `finish` **之前**声明：`finish` 要清掉它，
       *   而 `finish` 又被下面的 `idle()` 间接引用 —— 声明顺序错了会在
       *   运行时报 TDZ 错误（那种报错发生在真实断连时，测试很难覆盖到）。
       *
       * ⚠ 类型必须显式写成 `NodeJS.Timeout | undefined`：它只在这里声明、
       *   在 `idle()` 里赋值，靠推断会得到「有的位置是 any」。
       */
      let reidleTimer: NodeJS.Timeout | undefined

      /** @param reason 断开原因；不传 = 服务器正常关了连接（resolve 而不是 reject） */
      const finish = (reason?: string): void => {
        if (done)
          return
        done = true
        clearTimeout(reidleTimer)
        try {
          socket.destroy()
        }
        catch {}
        if (reason)
          reject(new Error(reason))
        else
          resolve()
      }

      /** 服务器报告的邮件总数 */
      let exists = -1
      /** 已经推给插件的那个数（避免同一封推两次） */
      let notified = -1
      let tag = 0

      /**
       * 状态机位置（`WatchPhase`）。
       *
       * ⚠ 关键：**问候语是未标记的**（`* OK [CAPABILITY …] ready`），不是带标记的
       *   `OK`。所以「等问候的响应」不能靠等某个 tag —— 要等的是**
       *   第一条以 `* ` 开头的行**。
       *
       *   一开始写成「phase = greeting，等第一个带标记的响应再发 LOGIN」，
       *   结果是：问候语被跳过 → 状态机永远停在 greeting → 一条 LOGIN 都没发出去 →
       *   客户端一条消息都收不到，连接静静地挂着。
       */
      let phase: WatchPhase = 'greeting'

      /** @param text 完整的一行命令（自带 CRLF） */
      const send = (text: string): void => {
        if (socket.destroyed)
          return
        socket.write(text)
      }

      const nextTag = (): string => `A${String(++tag).padStart(4, '0')}`

      /*
       * ⚠ 先把「待发出」的队列建好，再按响应推进。
       *
       * 用状态机而不是 `await` 每个命令：`IDLE` 之后的响应**不是**一问一答
       * ——服务器会在任意时刻插入 `* n EXISTS`，永久等待某条命令的 tag 会卡死。
       */
      const idle = (): void => {
        const current = nextTag()
        send(`${current} IDLE\r\n`)
        /*
         * RFC 2177 建议客户端 IDLE 不超过 29 分钟（多数服务器 30 分钟会断空闲连接）。
         * 到点重挂一次，避免「看着连着、其实服务端已经准备踢了」。
         */
        reidleTimer = setTimeout(() => {
          if (done)
            return
          send('DONE\r\n')
          // `DONE` 的响应到达后再重新 IDLE（见 handleLine 里 phase === 'done'）
        }, WATCH_REIDLE_MS)
      }

      /** @param line 一条完整的响应行（已去掉 CRLF） */
      const handleLine = (line: string): void => {
        if (TRACE)
          log(`  [watch] ← ${line}`)

        // --- 服务器主动推的未标记响应 ------------------------------------------
        const existsMatch = /^\* (\d+) EXISTS\b/.exec(line)
        if (existsMatch) {
          exists = Number.parseInt(existsMatch[1], 10)

          /*
           * 只在**变大**时推。变小说明有人在别处删邮件 —— 那不是「新邮件」，
           * 而且此时游标后的增量抓取会自然发现没东西可拉，不需要额外处理。
           */
          if (notified >= 0 && exists > notified) {
            log(`WATCH ${host}:${port} 新邮件：${notified} → ${exists}`)
            sendToClient(ws, { type: 'mail', accountId, exists })
          }
          notified = exists
          return
        }

        if (line.startsWith('+ ')) {
          // `+ idling` —— 已经进入 IDLE，除了等和到点重挂，什么都不做
          return
        }

        /*
         * --- 问候语：**未标记**的 `* OK [...]` --------------------------------
         *
         * ⚠ 这是整个状态机最容易写错的地方。问候语没有 tag，所以不能靠
         *   「等某个 tag 的响应」来判断它到了 —— 要等的是「第一条 `* ` 开头的行」。
         *
         *   写错的表现很隐蔽：状态机永远停在 greeting，一条 LOGIN 都没发出去，
         *   而客户端那边只是**一条消息都收不到**（连接是好的，不报错）。
         */
        if (phase === 'greeting') {
          if (!line.startsWith('* '))
            return

          if (/^\* (?:OK|PREAUTH)\b/i.test(line)) {
            const loginTag = nextTag()
            phase = 'login'
            if (TRACE)
              log(`  [watch] → ${loginTag} LOGIN …`)
            send(`${loginTag} LOGIN ${quote(user)} ${quote(pass)}\r\n`)
            return
          }

          // `* BYE` 之类：服务器拒绝服务
          finish(`服务器问候失败：${line}`)
          return
        }

        // --- 带标记的响应（一条命令完成）--------------------------------------
        const tagged = /^A\d{4} (OK|NO|BAD)\b(.*)$/.exec(line)
        if (!tagged) {
          // 其它未标记响应（FLAGS / PERMANENTFLAGS / CAPABILITY …）与本次判断无关
          return
        }

        const [, status, rest] = tagged
        const ok = status === 'OK'

        if (phase === 'login') {
          if (!ok) {
            /*
             * 认证失败**不重试** —— 密码错时快速重连只会让服务器把账号锁掉。
             * 直接把错误交给插件，由它在界面上提示用户去改配置。
             */
            finish(`登录失败：${rest.trim() || '服务器拒绝'}`)
            return
          }
          const selectTag = nextTag()
          phase = 'select'
          send(`${selectTag} SELECT INBOX\r\n`)
          return
        }

        if (phase === 'select') {
          if (!ok) {
            finish(`无法打开收件箱：${rest.trim() || '服务器拒绝'}`)
            return
          }
          /*
           * 基准值 = SELECT 那一刻的 EXISTS。
           * 第一封在 SELECT 之后到达的邮件会让它从 exists 变成 exists+1，
           * 于是被推出去 —— 而 SELECT 之前就有的邮件不会被误推。
           */
          notified = exists >= 0 ? exists : 0
          phase = 'idle'
          log(`WATCH ${host}:${port} 已挂上 IDLE（当前 ${notified} 封）`)
          sendToClient(ws, { type: 'state', state: 'watching', exists: notified })
          idle()
          return
        }

        if (phase === 'idle' || phase === 'done') {
          /*
           * 到这里说明收到了某条命令的完成响应。两种可能：
           *   - `DONE` 的响应 → 立刻重新 IDLE；
           *   - `IDLE` 自己的响应（有些服务器在进入 IDLE 时就回 OK）→ 什么都不做。
           * 靠 phase 区分：`DONE` 发出时会把 phase 置为 'done'。
           */
          if (phase === 'done') {
            if (!ok) {
              finish(`DONE 被拒：${rest.trim() || '服务器拒绝'}`)
              return
            }
            phase = 'idle'
            idle()
          }
        }
      }

      // --- 事件接线 -----------------------------------------------------------

      socket.on('data', (chunk) => {
        if (TRACE)
          log(`  [watch] ← （${chunk.length} 字节）`)
        lines.push(Buffer.from(chunk))
        for (;;) {
          const line = lines.next()
          if (line === null)
            break
          handleLine(line)
          if (done)
            return
        }
      })

      socket.on('error', (error) => {
        // 同 `startPassthrough`：socket 的 error 在运行期带 `code`，`Error` 类型上没有
        const code = (error as NodeJS.ErrnoException).code
        const hint = code === 'UNABLE_TO_VERIFY_LEAF_SIGNATURE'
          || code === 'SELF_SIGNED_CERT_IN_CHAIN'
          || code === 'DEPTH_ZERO_SELF_SIGNED_CERT'
          ? '（邮件服务器用了自签证书；测试环境可设 TLS_REJECT_UNAUTHORIZED=0）'
          : ''
        finish(`tcp error: ${code ?? error.message}${hint}`)
      })

      socket.on('close', () => {
        finish()
      })

      socket.on('connect', () => {
        // 纯 TCP：没有 TLS 握手，连上就算进入问候阶段
        if (!useTls)
          phase = 'greeting'
      })

      // TLS 握手完成才算连上；握手失败由 `error` 事件报告
      if (useTls) {
        socket.on('secureConnect', () => {
          phase = 'greeting'
        })
      }
    })
  }

  return {
    start,
    stop,
    /** 扩展里该填的地址 */
    url: () => (HOST === '127.0.0.1' ? `ws://127.0.0.1:${PORT}/` : 'wss://<你的域名>/'),
  }
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
function sendToClient(ws: WebSocket, payload: ClientMessage): void {
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
function quote(value: string): string {
  if (/[\r\n]/.test(value))
    throw new Error('凭据里不能包含换行符')
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
}

/**
 * @param ms 毫秒
 * @returns 等待结束
 */
function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
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
function isFatalWatchError(message: string): boolean {
  return /登录失败|无法打开收件箱|invalid token|host not allowed|缺少有效的|缺少 user/.test(message)
}

/** 启动成功后的提示（每次启动都打，包括 `r` 重启之后） */
function logListening(): void {
  log(`IMAP 中继已启动：ws://${displayHost(HOST)}:${PORT}/`)
  log(`在扩展的账号配置里填：${HOST === '127.0.0.1' ? `ws://127.0.0.1:${PORT}/` : 'wss://<你的域名>/'}`)
  if (TRACE) {
    log('⚠️  RELAY_TRACE=1 —— 会把 IMAP 往返打到终端，**包括你的邮箱授权码**。')
    log('    只用来排查问题，看完请关掉（并清一下终端回滚缓冲）。')
  }
  if (!REJECT_UNAUTHORIZED)
    log('⚠️  TLS_REJECT_UNAUTHORIZED=0 —— 不校验证书链，仅限测试环境')
  if (HOST !== '127.0.0.1' && HOST !== 'localhost' && HOST !== '::1')
    log('⚠️  正在监听非本机地址：连上来的任何人都能用它连邮件服务器，务必同时设置 RELAY_TOKEN 与 ALLOWED_HOSTS')
  if (!RELAY_TOKEN)
    log('⚠️  未设置 RELAY_TOKEN —— 只应在 127.0.0.1 上使用')
  if (!ALLOWED_HOSTS.length)
    log('⚠️  未设置 ALLOWED_HOSTS —— 允许连任意邮件服务器')
}

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
class NoTargetError extends Error {
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
function resolveTarget(rawUrl: string | undefined): RelayTarget {
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
function hostAllowed(host: string): boolean {
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

/**
 * @param host 目标主机名
 * @returns 是否指向本机
 */
function isLoopback(host: string): boolean {
  return /^(?:localhost|127\.|0\.0\.0\.0|::1$|\[::1\])/i.test(host)
}

/**
 * 纯 IP 字面量不能当 SNI；给了反而会让部分服务器拒握手
 *
 * @param host 目标主机名
 * @returns 是否是 IP 字面量
 */
function isIpLiteral(host: string): boolean {
  return /^\d{1,3}(?:\.\d{1,3}){3}$/.test(host) || host.includes(':')
}

/**
 * @param host 目标主机名
 * @returns 可直接拼进 URL 的主机写法（IPv6 补方括号）
 */
function displayHost(host: string): string {
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
 * @param ws 要拒绝的连接
 * @param error 拒绝原因（可能是 `Error`，也可能是别处抛出来的任意值）
 */
function reject(ws: WebSocket, error: unknown): void {
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

// ---------------------------------------------------------------------------
// 启动 + 交互式控制台
// ---------------------------------------------------------------------------

const relay = createRelayServer()

/**
 * 占用端口的那个进程的 PID（没有则 null）。
 *
 * 用 `netstat` 而不是「试着连一下」：能连上只说明**有人**在监听，
 * 而我们要的是**杀掉谁**。拿不到 PID 就没法给出可执行的选项。
 *
 * @param port 要查的端口
 * @returns 监听该端口的 PID
 */
function findPortOwner(port: number): number | null {
  try {
    if (process.platform === 'win32') {
      const output = execFileSync('netstat', ['-ano', '-p', 'TCP'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
      for (const line of output.split('\n')) {
        const parts = line.trim().split(/\s+/)
        // 形如：  TCP    127.0.0.1:8787    0.0.0.0:0    LISTENING    9072
        if (parts.length < 5 || parts[3] !== 'LISTENING')
          continue
        const local = parts[1]
        // 只比端口号：地址可能是 `127.0.0.1:8787` 或 `[::]:8787`
        if (local.slice(local.lastIndexOf(':') + 1) !== String(port))
          continue
        const pid = Number.parseInt(parts[4], 10)
        if (Number.isFinite(pid) && pid > 0)
          return pid
      }
      return null
    }

    const output = execFileSync('lsof', ['-ti', `tcp:${port}`, '-sTCP:LISTEN'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
    const pid = Number.parseInt(output.trim().split('\n')[0] ?? '', 10)
    return Number.isFinite(pid) && pid > 0 ? pid : null
  }
  catch {
    // netstat / lsof 不可用，或没有匹配的监听者
    return null
  }
}

/**
 * 结束一个进程。
 *
 * ⚠ 只接受**具体 PID**，不做「杀掉所有 node」那种事 —— 用户机器上跑着别的
 *   Node 程序（编辑器插件、开发服务器）是常态，按名字杀会连带干掉它们。
 *
 * @param pid 要结束的进程号
 * @returns 是否成功
 */
function killProcess(pid: number): boolean {
  try {
    if (process.platform === 'win32')
      execFileSync('taskkill', ['/PID', String(pid), '/F'], { stdio: 'ignore' })
    else
      execFileSync('kill', ['-9', String(pid)], { stdio: 'ignore' })
    return true
  }
  catch {
    return false
  }
}

/**
 * 同步地问一个 `[Y/n]` 问题，直接回车算同意。
 *
 * ⚠ 用**同步**读（`readSync`）而不是 `readline.question()`，理由是时机：
 *
 *   这一步发生在任何 `await` 之前，而顶层 await 期间的 stdin 读取在部分终端下会
 *   丢字符（`readline` 的异步 `line` 事件可能在后来的某个 await 之后才被派发，
 *   那时 stdin 的所有权已经准备交给运行期控制台了）。
 *   同步读把「问一个问题」变成一段不被打断的代码，没有这个竞态。
 *
 * ⚠ 非交互式（管道 / 后台服务）时**直接返回 false**，不让调用方卡在一个
 *   永远不来的回答上 —— 中继的长期形态是后台服务，那条路必须能无人工跑通。
 *
 * @param query 提示语（自带 `[Y/n] `）
 * @returns 是否同意
 */
function confirm(query: string): boolean {
  if (!process.stdin.isTTY)
    return false

  process.stdout.write(query)

  const wasRaw = process.stdin.isRaw
  process.stdin.setRawMode(true)
  process.stdin.resume()

  let answer = ''
  const byte = Buffer.alloc(1)

  try {
    for (;;) {
      if (readSync(0, byte, 0, 1, null) === 0)
        break // EOF：当作「同意默认值」
      const char = byte.toString('utf8')

      if (char === '\u0003') { // Ctrl+C
        process.stdout.write('\n')
        process.exit(130)
      }
      if (char === '\r' || char === '\n')
        break
      // 退格：把已输入的字符删掉（否则用户敲错就只能 Ctrl+C）
      if (char === '\u007F' || char === '\b') {
        if (answer) {
          answer = answer.slice(0, -1)
          process.stdout.write('\b \b')
        }
        continue
      }
      if (char >= ' ') {
        answer += char
        process.stdout.write(char)
      }
    }
  }
  finally {
    // ⚠ 必须还原 raw 模式：后面运行期控制台要用行模式
    process.stdin.setRawMode(wasRaw)
    process.stdin.pause()
    process.stdout.write('\n')
  }

  const normalized = answer.trim().toLowerCase()
  return normalized === '' || normalized === 'y' || normalized === 'yes'
}

/**
 * 启动；端口被占用时**问一句**要不要杀掉占用者。
 *
 * 原来的做法是直接失败并让用户自己去执行 `pnpm relay:kill` —— 那是两步操作，
 * 而用户此刻的意图很明确（「我要把中继跑起来」），多一步只是摩擦。
 *
 * @returns 是否启动成功
 */
async function startWithPortCheck(): Promise<boolean> {
  try {
    await relay.start()
    return true
  }
  catch (error) {
    // `EADDRINUSE` 是 `net` 抛出来的唯一带 `code` 的错误（同 socket 的 error）
    if ((error as NodeJS.ErrnoException).code !== 'EADDRINUSE')
      throw error
  }

  const owner = findPortOwner(PORT)

  if (owner === null) {
    log(`端口 ${PORT} 被占用，但查不出是哪个进程（netstat / lsof 不可用）。`)
    log(`换一个端口：  pnpm relay --port ${PORT + 1}`)
    return false
  }

  /*
   * ⚠ 提示里要说清「上次的中继可能没退干净」这件事。
   *   用户的直觉是「我明明关了终端」，不说原因的话他会怀疑是脚本的问题。
   */
  log(`端口 ${PORT} 已被占用（PID ${owner}）。`)
  log('  多半是上一次的中继没退干净 —— 关掉终端窗口不一定会带走它')
  log('  （`pnpm relay` 会再 fork 一层 node，IDE 的「停止」有时只结束了外层 shell）。')

  if (!confirm(`要结束 PID ${owner} 并用端口 ${PORT} 启动吗？[Y/n] `)) {
    log(`已取消。也可以换个端口：  pnpm relay --port ${PORT + 1}`)
    return false
  }

  if (!killProcess(owner)) {
    log(`无法结束 PID ${owner}（可能需要管理员权限）。`)
    log(`换一个端口：  pnpm relay --port ${PORT + 1}`)
    return false
  }

  // 给内核一点时间回收监听套接字，否则紧接着的 listen 仍可能 EADDRINUSE
  await new Promise(resolve => setTimeout(resolve, 300))

  try {
    await relay.start()
    log(`已结束 PID ${owner}`)
    return true
  }
  catch (error) {
    /*
     * ⚠ `catch` 的形参在 `strict` 下是 `unknown`，这里断言成 `Error` 是**收窄**、
     *   不是掩盖：能走到这里的只有 `relay.start()`，而它只会转发 ws 的 `error`
     *   事件（那一定是 `Error`）。下面 `main()` / `restart()` 里是同一套写法。
     */
    log(`结束 PID ${owner} 后仍无法启动：${(error as Error).message}`)
    return false
  }
}

/**
 * 入口。
 *
 * ⚠ 必须包在 `async function main()` 里，**不能**在模块顶层直接 `await`：
 *   根 `package.json` 没有 `"type": "module"`，esno（esbuild）会把本文件编译成
 *   CommonJS，而 CJS 输出格式下 esbuild 直接拒绝顶层 await ——
 *   「Top-level await is currently not supported with the "cjs" output format」。
 *   症状是中继**一个字节都不发**：`pnpm relay` 与 `pnpm relay:test` 全部起不来。
 *
 *   给根 `package.json` 加 `"type": "module"` 也能绕开，但那会改掉**整个仓库**的
 *   模块解析语义（vite 配置、构建产物、既有脚本），代价远大于收益；
 *   包一层 `main()` 只影响这一个文件。
 *
 * ⚠ 顺序不能动：先启动服务（`startWithPortCheck` 里含端口被占用时的 `[Y/n]` 提问），
 *   失败就 `exit(1)`，**成功之后**才决定要不要开交互式控制台。
 */
async function main(): Promise<void> {
  let started = false
  try {
    started = await startWithPortCheck()
  }
  catch (error) {
    log(`启动失败：${(error as Error).message}`)
  }

  if (!started)
    process.exit(1)

  startConsole()
}

/**
 * 交互式控制台：`q` 退出、`r` 重启，都要按回车。
 *
 * ⚠ 只在**交互式终端**里启用（`process.stdin.isTTY`）。
 *
 *   中继的长期形态是后台服务（见 `ai-docs/decisions/relay-deployment.md`），
 *   而服务是没有 TTY 的。不加这个判断的话，后台运行时 `readline` 会挂在
 *   一个永远不来的 stdin 上 —— 轻则无输出，重则进程被 stdin 的 EOF 直接带走。
 */
function startConsole(): void {
  if (!process.stdin.isTTY) {
    log('（非交互式终端：q 退出 / r 重启 不可用，用 Ctrl+C 结束）')
    return
  }

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout })

  rl.setPrompt('中继运行中 › [r] 重启  [q] 退出\n> ')
  rl.prompt()

  rl.on('line', (line) => {
    const command = line.trim().toLowerCase()

    if (command === 'q' || command === 'quit' || command === 'exit') {
      rl.close()
      return
    }

    if (command === 'r' || command === 'restart') {
      void restart()
      return
    }

    if (command)
      process.stdout.write(`未知命令「${command}」—— 可用：[r] 重启 / [q] 退出\n`)

    rl.prompt()
  })

  rl.on('close', () => {
    void shutdown('用户退出')
  })
}

/** 控制台的 `r`：重启服务（`stop()` 之后再 `start()`，失败则留着控制台） */
async function restart(): Promise<void> {
  process.stdout.write('正在重启中继…\n')
  await relay.stop()
  try {
    await relay.start()
  }
  catch (error) {
    log(`重启失败：${(error as Error).message}`)
    // 重启失败就把控制台留着，用户可以再敲一次 r 或 q
    process.stdout.write('> ')
  }
}

/**
 * 退出。
 *
 * ⚠ 必须**主动**关掉服务与 readline：不关的话 `server` 还持着监听句柄，
 *   进程不会自己结束 —— 用户敲了 `q` 却发现终端卡在那里。
 *
 * @param reason 退出原因（`q` / `Ctrl+C` / `SIGTERM` …，只进日志）
 */
async function shutdown(reason: string): Promise<void> {
  process.stdout.write(`\n正在停止中继（${reason}）…\n`)
  await relay.stop()
  process.exit(0)
}

// Ctrl+C / kill 也要走同一套清理（否则端口可能被 TIME_WAIT 占住一会儿）
process.on('SIGINT', () => {
  void shutdown('Ctrl+C')
})
process.on('SIGTERM', () => {
  void shutdown('SIGTERM')
})

/**
 * @param message 日志正文（前缀与时间戳由这里补）
 */
function log(message: string): void {
  process.stdout.write(`[imap-relay] ${new Date().toISOString()} ${message}\n`)
}

/**
 * 打印一条连接上的原始字节（只在 `RELAY_TRACE=1` 时）。
 *
 * ⚠ 打的是**文本行**，二进制正文只报长度 —— IMAP 的 `FETCH` 会回几千字节的邮件，
 *   整段打出来会把终端刷爆，反而看不到关键的那几行命令。
 *
 * ⚠ 这里会打出 `LOGIN` 命令，也就是**用户的邮箱授权码**。
 *   所以默认关闭，且打开时明确警告（见 `logListening`）。
 *
 * @param direction 箭头方向（→ 扩展发往服务器，← 服务器发往扩展）
 * @param bytes 这一段的原始字节
 */
function trace(direction: '→' | '←', bytes: Buffer): void {
  if (!TRACE)
    return

  const text = bytes.toString('utf8')

  /*
   * 含控制字符（除 CR/LF）的当作二进制正文，只报长度。
   *
   * eslint-disable 是必要的：这条规则本意是「别在正则里塞控制字符」，
   * 而这里**就是要**判断「有没有控制字符」—— 控制字符正是被检测的对象。
   */
  // eslint-disable-next-line no-control-regex -- 见上：控制字符就是被检测的对象
  if (/[\u0000-\u0008\u000E-\u001F]/.test(text)) {
    log(`  ${direction} （${bytes.length} 字节正文）`)
    return
  }

  for (const line of text.split('\r\n').filter(Boolean).slice(0, 20))
    log(`  ${direction} ${line}`)
}

/*
 * ⚠ 调用点必须在**文件末尾**，不能提到上面去：`main()` 会一路同步执行到第一个
 *   `await`（也就是 `relay.start()` 里那个等 `listening` 的 Promise），
 *   而 `process.on('SIGINT'…)` 与会话控制的注册都在这之前 ——
 *   提前调用就等于让「注册信号处理」跑到「服务开始监听」之后，那是行为变化。
 */
void main()
