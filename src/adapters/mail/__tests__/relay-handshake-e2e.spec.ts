// @vitest-environment node
//
// ⚠ 这一行是**必需的**（理由同 `relay-watch.spec.ts`）：本文件要起真的 Node TCP
//   server 与子进程，而 jsdom 会往全局塞它自己的 `Event` / `EventTarget`，
//   Node 的 `net.Socket` 内部断言事件是 Node 的 `Event` 实例。

import type { Server, Socket } from 'node:net'
import { createServer } from 'node:net'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { WebSocket } from 'ws'
import { startRelayForTest } from '../testing/start-relay'

/**
 * **端到端**：真中继进程 + 一个「握手装死」的假邮件服务器。
 *
 * ## 这一组在防什么
 *
 * `relay-handshake-timeout.spec.ts` 测的是看门狗**本身**（用假计时器）。
 * 这一组补的是它**接进真进程之后**的那一段 —— 也就是用户实际会看到的：
 *
 *   1. 中继真的把半开连接踢掉（假服务器的 socket 被销毁）；
 *   2. 日志里真的写出「握手超时」而不是静默重连（否则「为什么推送停了」没法查）；
 *   3. 退避重连真的跑起来（假服务器**收到第二条连接**）——
 *      这一条是整个修复的意义所在：改之前 `watchOnce` 的 promise 永不 settle，
 *      退避循环永不触发，用户「再也不实时收信」而日志一片干净。
 *
 * ## 为什么用**短**握手超时
 *
 * 默认 30 秒是给真机的（TLS + 登录 + SELECT 正常在几秒内完成）。测试里用环境变量
 * `WATCH_HANDSHAKE_TIMEOUT_MS=600` 把它压到亚秒级，否则这个文件要跑半分钟。
 * 顺带这也验证了那个环境变量真的生效（它是新加的配置项）。
 */

const RELAY_PORT = 18995
const SILENT_IMAP_PORT = 19155

/** 假邮件服务器收到的连接（一次连接一个 socket，用来数「重连了几次」） */
const accepted: Socket[] = []

/** 装死的假邮件服务器（`beforeAll` 里建、`afterAll` 里关） */
let silentServer: Server
let relay: import('node:child_process').ChildProcess
let relayOutput = ''

beforeAll(async () => {
  silentServer = createServer((socket) => {
    /*
     * ⚠ 收下连接但**一个字节都不写**：TCP 看起来是通的、IMAP 永远不给问候语 ——
     *   这正是 NAT 表过期 / 中间盒静默丢包时真机的样子。
     */
    accepted.push(socket)
    socket.on('error', () => {})
  })
  await new Promise<void>(resolve => silentServer.listen(SILENT_IMAP_PORT, '127.0.0.1', resolve))
}, 20000)

beforeAll(async () => {
  relay = await startRelayForTest(RELAY_PORT, { WATCH_HANDSHAKE_TIMEOUT_MS: '600' })
  relay.stdout?.on('data', (chunk) => {
    relayOutput += chunk.toString()
  })
  relay.stderr?.on('data', (chunk) => {
    relayOutput += chunk.toString()
  })
}, 30000)

afterAll(() => {
  relay?.kill()
  for (const socket of accepted)
    socket.destroy()
  silentServer?.close()
})

/** 发一个 watch 请求，指向那个装死的服务器，并记录中继推来的消息 */
function openWatchClient(): Promise<{ ws: WebSocket, messages: Array<Record<string, unknown>> }> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${RELAY_PORT}/`)
    const messages: Array<Record<string, unknown>> = []
    ws.on('message', (data) => {
      try {
        messages.push(JSON.parse(data.toString()) as Record<string, unknown>)
      }
      catch {}
    })
    ws.on('error', reject)
    ws.on('open', () => {
      ws.send(JSON.stringify({
        __watch: 1,
        accountId: 'acc-handshake',
        host: '127.0.0.1',
        port: SILENT_IMAP_PORT,
        tls: false,
        user: 'u',
        pass: 'p',
      }))
      resolve({ ws, messages })
    })
  })
}

/** 等一个条件成立（轮询，避免用固定 sleep 造成偶发失败） */
async function waitFor(predicate: () => boolean, timeoutMs: number, what: string): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate())
      return
    await new Promise(resolve => setTimeout(resolve, 50))
  }
  throw new Error(`等待「${what}」超时（${timeoutMs}ms）`)
}

describe('中继 watch：握手装死 → 超时 + 退避重连（端到端）', () => {
  it('踢掉半开连接、日志写出「握手超时」，并且真的重连了', async () => {
    const { ws, messages } = await openWatchClient()

    // 1. 中继确实连到了假服务器（先确认链路是通的，否则后面的断言毫无意义）
    await waitFor(() => accepted.length >= 1, 5000, '假服务器收到第一条连接')

    /*
     * 2. 超时之后连接必须被销毁。
     *
     * ⚠ 改之前这里永远等不到：连接会一直挂着，`accepted[0].destroyed` 永远是 false，
     *   而中继日志里一条错误都没有。
     */
    await waitFor(() => accepted[0]?.destroyed === true, 5000, '半开连接被中继踢掉')

    // 3. 日志里必须能看出是「握手超时」——否则「为什么推送停了」不可排查
    await waitFor(() => relayOutput.includes('握手超时'), 5000, '日志里出现「握手超时」')

    /*
     * 4. 退避重连真的跑起来了（第一条退避是 2 秒，见 `WATCH_RETRY_DELAYS_MS`）。
     *
     *    这一条是**整个修复的意义**：promise 不 settle 的话重连循环永远不会走到下一轮。
     */
    await waitFor(() => accepted.length >= 2, 15000, '中继重连（第二条连接）')

    // 插件侧也应该收到 reconnecting —— 它据此在界面上显示「正在重连」
    await waitFor(
      () => messages.some(message => message.type === 'state' && message.state === 'reconnecting'),
      5000,
      '插件收到 reconnecting',
    )

    /*
     * `retryInMs` 必须是正数：插件只用它显示「N 秒后重试」，给 0 / NaN 会让界面
     * 显示「0 秒后重试」并一直闪 —— 而它来源于 `WATCH_RETRY_DELAYS_MS` 那串常量。
     */
    const reconnecting = messages.find(message => message.type === 'state' && message.state === 'reconnecting')
    expect(Number(reconnecting?.retryInMs)).toBeGreaterThan(0)

    ws.close()
  }, 30000)
})
