import type { WebSocket } from 'ws'
import type { WatchOptions, WatchPhase } from './protocol'
import { Buffer } from 'node:buffer'
import { createWatchHandshakeWatchdog } from '../watch-handshake'
import { TRACE, WATCH_HANDSHAKE_TIMEOUT, WATCH_REIDLE_MS } from './config'
import { LineBuffer } from './line-buffer'
import { log } from './logger'
import { quote, sendToClient } from './protocol'
import { connectUpstream, describeUpstreamError } from './upstream'

/**
 * 挂一次 `IDLE`，直到连接断开。
 *
 * @param ws 客户端连接（有新邮件时往这里推）
 * @param options 已经校验并归一过的连接参数
 * @returns 连接结束时 resolve
 */
export function watchOnce(ws: WebSocket, options: WatchOptions): Promise<void> {
  const { host, port, useTls, user, pass, accountId } = options

  /*
   * ⚠ `Promise<void>` 的显式类型参数是必需的：不给的话 `Promise<unknown>`，
   *   而 `finish()` 里那条不成功的路径按设计是 `resolve()`（无参）——
   *   那就成了「Expected 1 arguments, but got 0」。
   */
  return new Promise<void>((resolve, reject) => {
    const socket = connectUpstream({ host, port, tls: useTls })

    /*
     * ⚠ IDLE 会长期静默（可能几十分钟没有任何字节），所以**不能**沿用普通连接的
     *   15 分钟空闲超时 —— 那会把一条健康的连接当成超时踢掉。
     *
     * ⚠ 但这样一来握手阶段就**完全没有**时间上限了（这段静默与 IDLE 的静默在
     *   socket 层面长得一模一样，没法用同一个超时值区分）。所以下面另挂一个
     *   握手看门狗，进入 IDLE 时停表 —— 见 `scripts/watch-handshake.ts` 的文件头。
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

    /**
     * 握手超时的原因（看门狗写、`close` 读）。
     *
     * 存在的唯一目的：把「握手挂了（TCP 半开）」与「服务器正常关了连接」区分开。
     * 前者必须报错（用户要知道推送为什么停了），后者按原设计是静默 resolve
     * （服务器踢掉空闲连接是常态）。
     */
    let handshakeTimeoutReason: string | undefined

    const handshakeWatchdog = createWatchHandshakeWatchdog({
      timeoutMs: WATCH_HANDSHAKE_TIMEOUT,
      /*
       * ⚠ 只有 `onKill` 里那个 `socket.destroy()` 能让 `watchOnce` 的 promise
       *   收尾（`close` → `finish`）—— 看门狗自己只负责「到点了、该动手了」。
       *   原因写进局部变量，由 `close` 处理成「握手超时」而不是静默 resolve。
       */
      onKill: (reason) => {
        handshakeTimeoutReason = reason
        try {
          socket.destroy()
        }
        catch {}
      },
      log: message => log(`WATCH ${host}:${port} ${message}`),
    })

    /** @param reason 断开原因；不传 = 服务器正常关了连接（resolve 而不是 reject） */
    const finish = (reason?: string): void => {
      if (done)
        return
      done = true
      clearTimeout(reidleTimer)
      handshakeWatchdog.close()
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
        /*
         * ⚠ 握手看门狗到这里必须**停表**：`SELECT` 成功意味着「连上了、登录了、
         *   收件箱也打开了」，之后的静默是 IDLE 的正常静默（可能几十分钟），
         *   不属于「握手卡住」。
         */
        handshakeWatchdog.enterIdle()
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
      // 与透传连接共用错误码和证书提示。
      const detail = describeUpstreamError(error)
      finish(`tcp error: ${detail}`)
    })

    socket.on('close', () => {
      /*
       * ⚠ 握手看门狗把半开连接踢掉时走的也是这条路（它只负责报告 + `destroy()`）。
       *   不带原因的话 `finish()` 会**静默 resolve** —— 上层会把它当成
       *   「服务器正常关了连接」直接退避重连，日志里只剩一条「WATCH 断开」，
       *   于是「为什么推送停了」又变成不可排查的。
       */
      finish(handshakeTimeoutReason)
    })

    /*
     * socket 自己的超时事件也接到同一套判断上。
     *
     * ⚠ 主手段是看门狗里的 `setTimeout`（见 `scripts/watch-handshake.ts` 的说明：
     *   半开连接的 socket 永远不会有事件，只有定时器靠得住）。这条是**防御性**的：
     *   它覆盖「将来有人给 watch 连接重新启用 socket 超时」的情况 ——
     *   那时超时必须按同一个判据（握手阶段才踢）处理，而不是被忽略。
     */
    socket.on('timeout', () => {
      handshakeWatchdog.onSocketTimeout()
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
