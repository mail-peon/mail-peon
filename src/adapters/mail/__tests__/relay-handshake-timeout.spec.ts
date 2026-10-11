// @vitest-environment node
//
// ⚠ 这一行是**必需的**（理由同 `relay-watch.spec.ts`）：本文件要起真的 Node TCP
//   server，而 jsdom 会往全局塞它自己的 `Event` / `EventTarget`，
//   Node 的 `net.Socket` 内部断言事件是 Node 的 `Event` 实例。

import type { AddressInfo, Server, Socket } from 'node:net'
import { connect, createServer } from 'node:net'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  createWatchHandshakeWatchdog,
  DEFAULT_WATCH_HANDSHAKE_TIMEOUT_MS,
  resolveWatchHandshakeTimeoutMs,
} from '../../../../scripts/watch-handshake'

/**
 * watch 模式**握手看门狗**的回归测试（被测模块：`scripts/watch-handshake.ts`）。
 *
 * ## 这一组在防什么
 *
 * `watchOnce()` 里 `socket.setTimeout(0)` 关掉了唯一的 socket 级超时（IDLE 会长期
 * 静默，不能沿用普通连接那个 15 分钟空闲超时），而 `reidleTimer` 只在 `SELECT`
 * 成功、真正进入 IDLE 之后才存在。于是**握手阶段没有任何时间上限**：
 *
 *   TCP 半开（NAT 表过期、中间盒静默丢包、客户端切网络）时 socket 既不 emit
 *   `error` 也不 emit `close` —— `watchOnce()` 的 promise **永不 settle**，
 *   `startWatch()` 的 `for (;;)` 退避重连永不触发。症状是用户「再也不实时收信」
 *   而中继日志上**一条错误都没有**。
 *
 * ## ⚠ 为什么不能 import `scripts/imap-relay.ts` 来测
 *
 * 那个文件末尾有 `void main()`，**一 import 就真的把中继服务起起来**
 * （实测：测试里 import 它，8787 端口立刻被占用，还会打印「IMAP 中继已启动」）。
 * 所以看门狗被抽成了无副作用的独立模块 —— 这既是它能被测的前提，
 * 也让 `watchOnce()` 里那段引用不清的定时器逻辑有了一个明确的去处。
 *
 * ⚠ 用**假计时器**把时间推过去，而不是真等 30 秒：真等会让这个文件成为整条流水线
 *   上最慢的一环，而「到点时会不会真的动手」用假时钟可以确定性地断言。
 */

const sockets = new Set<Socket>()
const servers = new Set<Server>()

/** 起一个「接受连接但一个字都不回」的 TCP 服务器 —— 精确复刻半开的邮件服务器 */
async function startSilentServer(): Promise<number> {
  const server = createServer((socket) => {
    /*
     * ⚠ 收下连接但**不写任何字节**：这就是「TCP 通、应用层不应答」。
     *   真机上的区别只是它由 NAT / 中间盒造成，而不是由我们主动不吭声。
     */
    sockets.add(socket)
    socket.on('error', () => {})
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  servers.add(server)
  return (server.address() as AddressInfo).port
}

/** 连到一个 TCP 服务器并等连接建立 */
async function connectTo(port: number): Promise<Socket> {
  const socket = connect({ host: '127.0.0.1', port })
  sockets.add(socket)
  await new Promise<void>(resolve => socket.once('connect', resolve))
  return socket
}

afterEach(() => {
  vi.useRealTimers()
  for (const socket of sockets)
    socket.destroy()
  sockets.clear()
  for (const server of servers)
    server.close()
  servers.clear()
})

describe('watch 握手看门狗', () => {
  it('超时配置不会退化成 0 / NaN（那会让每条连接刚连上就被踢）', () => {
    /*
     * 这条看着像废话，但它防的是一个**看起来很蠢、后果很重**的错：
     * 环境变量拼错、或写成 `'abc'` 时 `parseInt` 给出 NaN，而
     * `setTimeout(fn, NaN)` 按 1ms 处理 —— 每条 watch 连接刚连上就被踢掉。
     * 用户侧表现是「永远连不上、日志疯狂重连」，代码看起来却完全正确。
     */
    expect(DEFAULT_WATCH_HANDSHAKE_TIMEOUT_MS).toBeGreaterThan(1000)

    expect(resolveWatchHandshakeTimeoutMs(undefined)).toBe(DEFAULT_WATCH_HANDSHAKE_TIMEOUT_MS)
    expect(resolveWatchHandshakeTimeoutMs('')).toBe(DEFAULT_WATCH_HANDSHAKE_TIMEOUT_MS)
    expect(resolveWatchHandshakeTimeoutMs('abc')).toBe(DEFAULT_WATCH_HANDSHAKE_TIMEOUT_MS)
    expect(resolveWatchHandshakeTimeoutMs('0')).toBe(DEFAULT_WATCH_HANDSHAKE_TIMEOUT_MS)
    expect(resolveWatchHandshakeTimeoutMs('-5')).toBe(DEFAULT_WATCH_HANDSHAKE_TIMEOUT_MS)
    // 有效值原样生效（测试 / 真机调参都靠它）
    expect(resolveWatchHandshakeTimeoutMs('1500')).toBe(1500)
  })

  it('握手到点 → 报告并让调用方销毁 socket（否则 promise 永不 settle）', async () => {
    const port = await startSilentServer()
    const socket = await connectTo(port)

    vi.useFakeTimers()
    const kills: string[] = []
    const logs: string[] = []
    createWatchHandshakeWatchdog({
      timeoutMs: 1000,
      log: message => logs.push(message),
      onKill: (reason) => {
        kills.push(reason)
        socket.destroy()
      },
    })

    // 到点之前：服务器一直不给问候语，连接**看起来**是好的
    expect(socket.destroyed).toBe(false)
    expect(kills).toHaveLength(0)

    vi.advanceTimersByTime(1001)

    expect(kills).toHaveLength(1)
    // 原因必须能看出是「握手超时」—— 否则日志里读不出「为什么推送停了」
    expect(kills[0]).toContain('握手超时')
    expect(logs.join('\n')).toContain('握手超时')
    expect(socket.destroyed).toBe(true)
  })

  it('进入 IDLE 后停表：长期静默不再被踢（本改动最怕改坏的地方）', async () => {
    const port = await startSilentServer()
    const socket = await connectTo(port)

    vi.useFakeTimers()
    const kills: string[] = []
    const watchdog = createWatchHandshakeWatchdog({
      timeoutMs: 1000,
      onKill: reason => kills.push(reason),
    })

    // SELECT 成功 → 进入 IDLE（真机上就是「已挂上 IDLE」那一行）
    watchdog.enterIdle()

    /*
     * ⚠ 把时间推过**好几倍**超时：IDLE 会静默几十分钟，看门狗要是没停表，
     *   一条健康的连接会被反复踢掉 —— 那是「实时收信又坏了」这个 bug 的翻版，
     *   而且比原来更难查：日志里全是重连，看起来像网络问题。
     */
    vi.advanceTimersByTime(1000 * 10)

    expect(kills).toHaveLength(0)
    expect(socket.destroyed).toBe(false)
  })

  it('close() 之后不再触发（连接已经结束，定时器不能留下）', async () => {
    const port = await startSilentServer()
    const socket = await connectTo(port)

    vi.useFakeTimers()
    const kills: string[] = []
    const watchdog = createWatchHandshakeWatchdog({
      timeoutMs: 1000,
      onKill: reason => kills.push(reason),
    })

    watchdog.close()
    vi.advanceTimersByTime(1000 * 10)

    expect(kills).toHaveLength(0)
    expect(socket.destroyed).toBe(false)
  })

  it('socket 的 timeout 事件：握手阶段动手，IDLE 阶段不动健康连接', () => {
    const kills: string[] = []

    // 握手阶段：该动手
    createWatchHandshakeWatchdog({
      timeoutMs: 1000,
      onKill: reason => kills.push(reason),
    }).onSocketTimeout()
    expect(kills).toHaveLength(1)
    expect(kills[0]).toContain('握手超时')

    // IDLE 阶段：不该动手（否则一条正在推邮件的健康连接会被掐断）
    const killsAfterIdle: string[] = []
    const idleWatchdog = createWatchHandshakeWatchdog({
      timeoutMs: 1000,
      onKill: reason => killsAfterIdle.push(reason),
    })
    idleWatchdog.enterIdle()
    idleWatchdog.onSocketTimeout()
    expect(killsAfterIdle).toHaveLength(0)
  })
})
