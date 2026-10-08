import type { MailAccount } from '~/logic/types'

/**
 * 常驻监听通道：连上中继的 watch 模式，等它推「有新邮件了」。
 *
 * ## 它解决的是什么
 *
 * MV3 的 Service Worker 空闲约 30 秒被回收，所以插件自己**挂不住**常驻 IMAP 连接。
 * 中继是普通进程，可以一直挂着 `IDLE`；有新邮件时它往这条 WebSocket 推一行 JSON，
 * Chrome 就会把 worker 唤醒（WebSocket 有消息是「事件」，能重置回收计时器）。
 *
 * ## 推送里**不带邮件内容**
 *
 * 只有「有几封」这个事实。收到之后一律走**普通的一轮同步**（`runSyncCycle`）——
 * 抓的是游标之后的所有邮件。这样插件侧只有一条抓取路径，
 * 不会出现「只有推送触发时才复现」的 bug。
 *
 * ## 为什么每条账号各一条 watch
 *
 * 中继的 watch 是「一个连接对应一个邮箱」的（它内部要为这条连接挂 `IDLE`）。
 * 多账号时是多个并发连接 —— 它们互不影响，某个账号密码错也只影响它自己。
 */

/** 中继推来的消息 */
export type WatchEvent
  /** 挂上 IDLE 了，`exists` 是当前邮件总数（基准值） */
  = | { type: 'state', state: 'watching', exists: number }
  /** 连接断了，正在退避重连 */
    | { type: 'state', state: 'reconnecting', retryInMs: number }
  /** 放弃重连（配置 / 凭据问题），需要用户处理 */
    | { type: 'state', state: 'failed', error: string, fatal: true }
  /** 有 `exists` 封邮件（比上次多） */
    | { type: 'mail', accountId: string, exists: number }

/** 把账户配置里的中继地址与凭据拼成 watch 请求 */
export function buildWatchRequest(account: MailAccount): Record<string, unknown> | null {
  const config = account.config
  const relayUrl = config.relayUrl?.trim()
  const host = config.host?.trim()
  const port = Number(config.port)
  const user = config.user?.trim()
  const pass = config.pass

  if (!relayUrl || !host || !Number.isFinite(port) || !user || !pass)
    return null

  /*
   * token 从**中继地址**里取（用户可能写成 `wss://host/?token=xxx`）。
   * 中继侧会拿它和 `RELAY_TOKEN` 比对 —— 走的是和透传连接同一套访问控制。
   */
  let token = ''
  try {
    token = new URL(relayUrl).searchParams.get('token') ?? ''
  }
  catch {
    return null
  }

  return {
    __watch: 1,
    accountId: account.id,
    host,
    port,
    tls: config.tls !== false,
    user,
    pass,
    token,
  }
}

/**
 * 开一条 watch 连接，并在断开后**自动重连**。
 *
 * ⚠ 重连逻辑放在这里（而不是中继里）是刻意的：中继的重连针对「到邮件服务器的
 *   连接」，这里的重连针对「插件到中继的连接」。两者失败原因完全不同 ——
 *   中继可能没启动、可能正在重启，而那时中继自己根本没机会重连。
 *
 * @param relayUrl 中继地址（`ws://127.0.0.1:8787/`）
 * @param request watch 请求体（见 `buildWatchRequest`）
 * @param onEvent 收到事件时回调
 * @returns 停止函数
 */
export function openWatchChannel(
  relayUrl: string,
  request: Record<string, unknown>,
  onEvent: (event: WatchEvent) => void,
): () => void {
  /** 停止后不再重连 */
  let stopped = false
  /** 当前连接 */
  let socket: WebSocket | null = null
  /** 重连定时器 */
  let retryTimer: ReturnType<typeof setTimeout> | null = null
  /** 连续失败次数（决定退避时长） */
  let attempt = 0

  /*
   * 插件侧的退避比中继侧短：这里的失败大多是「中继没起 / 正在重启」，
   * 而用户往往就在旁边等着，5 分钟一次的重连会让「实时」名不副实。
   */
  const RETRY_DELAYS_MS = [1000, 2000, 5000, 10000, 30000, 60000]

  function connect(): void {
    if (stopped)
      return

    let ws: WebSocket
    try {
      ws = new WebSocket(relayUrl)
    }
    catch {
      scheduleRetry()
      return
    }

    /*
     * ⚠ 这里**不设** `binaryType = 'arraybuffer'`。
     *
     *   透传通道（`relay.ts`）设了它，因为那条通道传的是**字节**（IMAP 命令）。
     *   watch 通道传的是**文本 JSON** —— 中继用 `ws.send(string)` 发，是文本帧。
     *
     *   照抄透传通道的写法会踩一个很隐蔽的坑：设了 `arraybuffer` 之后，
     *   连**文本帧**也会以 `ArrayBuffer` 递进来，于是下面那句「不是字符串就丢掉」
     *   会把中继推来的**每一条**消息都过滤掉 ——
     *   症状是「中继日志明明推了，插件一条都没收到」，而且两边都不报错。
     */
    socket = ws

    ws.addEventListener('open', () => {
      attempt = 0
      ws.send(JSON.stringify(request))
    })

    ws.addEventListener('message', (event) => {
      /*
       * 文本帧是 string；但这里对**两种形态都接受** —— 不要重犯上面的错：
       * 中继端将来若改用二进制帧（或换成别的实现），也不该让推送静默消失。
       *
       * ⚠ 二进制形态要覆盖 `ArrayBuffer` **与** `ArrayBufferView`：
       *   `Blob` / `Uint8Array` / Node 的 `Buffer` 都是后者。
       *   只判 `instanceof ArrayBuffer` 的话，二进制帧会被静默丢掉 ——
       *   那正是这次要修掉的那类 bug 的翻版。
       */
      const text = typeof event.data === 'string'
        ? event.data
        : event.data instanceof ArrayBuffer
          ? new TextDecoder().decode(event.data)
          : ArrayBuffer.isView(event.data)
            ? new TextDecoder().decode(event.data as ArrayBufferView)
            : null

      if (text === null)
        return

      let parsed: unknown
      try {
        parsed = JSON.parse(text)
      }
      catch {
        return
      }

      if (!parsed || typeof parsed !== 'object')
        return

      const message = parsed as Record<string, unknown>

      if (message.type === 'mail') {
        onEvent({
          type: 'mail',
          accountId: String(message.accountId ?? ''),
          exists: Number(message.exists ?? 0),
        })
        return
      }

      if (message.type === 'state') {
        const state = String(message.state)

        if (state === 'watching') {
          onEvent({ type: 'state', state: 'watching', exists: Number(message.exists ?? 0) })
          return
        }

        if (state === 'reconnecting') {
          onEvent({ type: 'state', state: 'reconnecting', retryInMs: Number(message.retryInMs ?? 0) })
          return
        }

        if (state === 'failed') {
          /*
           * ⚠ 中继说「重试无用」（密码错 / 白名单拒绝）时，**这里也不要重连**。
           *   重连只会重复同一次失败，而用户看到的是「一直在重连」——
           *   正确的反馈是明确告诉他去改配置。
           */
          stopped = true
          onEvent({ type: 'state', state: 'failed', error: String(message.error ?? '未知原因'), fatal: true })
        }
      }
    })

    ws.addEventListener('close', () => {
      socket = null
      scheduleRetry()
    })

    ws.addEventListener('error', () => {
      /*
       * `error` 之后浏览器一定会再触发 `close`，所以这里不做重连 ——
       * 两边都做会让重连次数翻倍（而且定时器会互相覆盖）。
       */
    })
  }

  function scheduleRetry(): void {
    if (stopped || retryTimer)
      return
    const delay = RETRY_DELAYS_MS[Math.min(attempt, RETRY_DELAYS_MS.length - 1)]
    attempt++
    retryTimer = setTimeout(() => {
      retryTimer = null
      connect()
    }, delay)
  }

  connect()

  return () => {
    stopped = true
    if (retryTimer) {
      clearTimeout(retryTimer)
      retryTimer = null
    }
    try {
      socket?.close()
    }
    catch {}
    socket = null
  }
}
