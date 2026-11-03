import process from 'node:process'
import { resolveWatchHandshakeTimeoutMs } from '../watch-handshake'

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

/** 端口。`--port 8788` / `PORT=8788` / 默认 41316（与 peon-burrow 默认端口对齐） */
const PORT_RAW = readOption('port', 'PORT', '41316')

export const PORT = Number.parseInt(PORT_RAW, 10)

/*
 * ⚠ 端口必须在启动**之前**校验。
 *
 * 交给 `new WebSocketServer({ port: NaN })` 的后果不是一条清晰的报错，而是
 * `options.port should be >= 0 and < 65536` 加上一个 **unhandled 'error' event**
 * 把进程打崩 —— 用户看到的是 Node 的堆栈，而不是「你端口写错了」。
 *
 * ⚠ 判据里排除 Vitest：这个文件的顶层语句在测试进程里也会被求值，而测试进程的
 *   端口不归本脚本管 —— `process.exit(1)` 会把整个测试进程带走（症状是「测试文件
 *   莫名其妙退出、没有任何断言失败」）。目前没有测试 import 本文件（看门狗已经被
 *   抽到无副作用的 `scripts/watch-handshake.ts`），但 `PORT` 是**环境变量**：
 *   谁在跑测试的 shell 里留了一个坏值，就会踩到这个 —— 所以留着这道护栏。
 */
if (!process.env.VITEST && (!Number.isInteger(PORT) || PORT < 0 || PORT > 65535)) {
  process.stderr.write(`[imap-relay] 端口无效：「${PORT_RAW}」（应为 0–65535 的整数）\n`)
  process.exit(1)
}

/** 监听地址。默认只绑本机 —— 中继能看到邮箱密码，不该默认对外 */
export const HOST = readOption('host', 'HOST', '127.0.0.1')

/** 可选：要求 `?token=…` 匹配（放到公网时**必须**设） */
export const RELAY_TOKEN = readOption('token', 'RELAY_TOKEN', '')

/**
 * 可选：逗号分隔的邮件服务器白名单，支持 `*` 通配。
 *
 * 例：`imap.qq.com,*.gmail.com`。空 = 允许任意。
 */
export const ALLOWED_HOSTS = readOption('allow-hosts', 'ALLOWED_HOSTS', '')
  .split(',')
  .map(item => item.trim().toLowerCase())
  .filter(Boolean)

/**
 * 是否校验证书链。
 *
 * 默认 **true**。置 0 只应用于「邮件服务器用自签证书」的测试环境 ——
 * 关掉之后中间人攻击不可检出，生产环境不要动它。
 */
export const REJECT_UNAUTHORIZED = readOption('tls-reject-unauthorized', 'TLS_REJECT_UNAUTHORIZED', '1') !== '0'

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
export const TRACE = process.env.RELAY_TRACE === '1'

/**
 * 常驻监听（watch）模式下，重发 `IDLE` 的间隔。
 *
 * RFC 2177 建议客户端的 IDLE 不要超过 **29 分钟** —— 多数服务器会在 30 分钟时
 * 主动断开空闲连接。这里取 25 分钟留出余量。
 *
 * （QQ 实测在 IDLE 下会持续推 `* n EXISTS`，没有出现过到点断开；
 *   但这是协议建议，不能赌某个服务器一直容忍。）
 */
export const WATCH_REIDLE_MS = 25 * 60 * 1000

/**
 * watch 模式下**握手阶段**的上限（连上 + 收问候语 + `LOGIN` + `SELECT`）。
 *
 * ⚠ 这个看门狗是必需的，不是保险 —— 完整论证（TCP 半开时 promise 永不 settle、
 *   退避重连永不触发、日志一条错误都没有）在它自己的模块里：
 *   `scripts/watch-handshake.ts`。
 *
 * ⚠ 单独一个模块而不是写在这里，是因为**这个文件 import 不得**：文件末尾的
 *   `void main()` 会真的把中继服务起起来（实测：测试里一 import 就占用了 41316）。
 *   而看门狗是这段逻辑里唯一「有状态、会记时、错了只能靠真机复现」的部分，
 *   必须可测。所以它被抽出去，这里只负责把环境变量喂给它。
 */
export const WATCH_HANDSHAKE_TIMEOUT = resolveWatchHandshakeTimeoutMs(
  readOption('watch-handshake-timeout', 'WATCH_HANDSHAKE_TIMEOUT_MS', ''),
)

/**
 * 断开后重连的退避阶梯（毫秒）。
 *
 * 先快后慢：如果是网络抖动，几秒就能恢复；如果是密码错 / 被限流，
 * 快速重试只会让情况更糟（QQ 会因为频繁建连直接拒连），所以逐级拉长到 5 分钟。
 */
export const WATCH_RETRY_DELAYS_MS = [2000, 5000, 15000, 30000, 60000, 120000, 300000]

/** 单条连接的空闲超时。IMAP 的 IDLE 会长期静默，所以给得比较宽 */
export const IDLE_TIMEOUT_MS = 15 * 60 * 1000

/**
 * 背压阈值：TCP → WebSocket 方向上「已发出但还没 flush 的字节数」上限。
 *
 * 没有它的话，邮箱推得快而 WebSocket 慢时会**无上限堆积**在内存里 ——
 * 日常小邮件看不出问题，收到一封 20MB 附件的邮件时进程内存会瞬间冲上去。
 *
 * 16 MiB 是个宽松值：正常 IMAP 响应远小于它，所以不会误触发暂停；
 * 而它一旦被触发，说明确实有积压，值得付出暂停/恢复的代价。
 */
export const HIGH_WATER_BYTES = 16 * 1024 * 1024
