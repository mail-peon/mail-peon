import type { WebSocket } from 'ws'
import type { WatchRequest } from './protocol'
import { ALLOWED_HOSTS, RELAY_TOKEN, WATCH_RETRY_DELAYS_MS } from './config'
import { log } from './logger'
import { isFatalWatchError, sendToClient } from './protocol'
import { hostAllowed } from './target'
import { watchOnce } from './watch-session'

/**
 * @param ms 毫秒
 * @returns 等待结束
 */
function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
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
export async function startWatch(ws: WebSocket, request: WatchRequest): Promise<void> {
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
