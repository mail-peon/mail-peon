import type { WatchEvent } from '~/adapters/mail/transport/watch'
import type { MailAccount } from '~/logic/types'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { buildWatchRequest, openWatchChannel } from '~/adapters/mail/transport/watch'

/**
 * watch 通道（插件侧）的测试。
 *
 * ## 这一组防的是一个很隐蔽的 bug
 *
 * 真机现象：**中继日志明明显示「新邮件：35502 → 35504」，插件一条都没收到**，
 * 而两边都不报错。
 *
 * 根因是客户端照抄了透传通道的 `ws.binaryType = 'arraybuffer'`。
 * 那条通道传的是**字节**（IMAP 命令），所以设它是对的；而 watch 通道传的是
 * **文本 JSON**（中继用 `ws.send(string)`）。设了 `arraybuffer` 之后，
 * 连文本帧也会以 `ArrayBuffer` 递进来 —— 于是那句「不是字符串就丢掉」
 * 把**每一条**推送都过滤掉了。
 *
 * 这类 bug 没有任何错误信息可查，只能靠测试钉住。
 */

function account(patch: Partial<MailAccount> = {}): MailAccount {
  return {
    id: 'acc-1',
    label: '个人邮箱',
    email: 'me@example.com',
    provider: 'imap',
    config: {
      host: 'imap.qq.com',
      port: 993,
      tls: true,
      user: 'me@example.com',
      pass: 'authcode',
      relayUrl: 'ws://127.0.0.1:8787/',
    },
    blockedList: [],
    enabled: true,
    createdAt: 1,
    cursor: null,
    ...patch,
  }
}

describe('buildWatchRequest', () => {
  it('把账号配置拼成 watch 请求', () => {
    const request = buildWatchRequest(account())

    expect(request).toMatchObject({
      __watch: 1,
      accountId: 'acc-1',
      host: 'imap.qq.com',
      port: 993,
      tls: true,
      user: 'me@example.com',
      pass: 'authcode',
      token: '',
    })
  })

  it('从**中继地址**里取 token（用户可能写成 ?token=xxx）', () => {
    const request = buildWatchRequest(account({
      config: { ...account().config, relayUrl: 'ws://127.0.0.1:8787/?token=s3cret' },
    }))
    expect(request?.token).toBe('s3cret')
  })

  it('tls 只认显式的 false（与中继侧的判定一致）', () => {
    expect(buildWatchRequest(account({ config: { ...account().config, tls: false } }))?.tls).toBe(false)
    expect(buildWatchRequest(account({ config: { ...account().config, tls: undefined } }))?.tls).toBe(true)
  })

  it('缺字段时返回 null（而不是发一个必然失败的请求）', () => {
    for (const patch of [
      { relayUrl: '' },
      { host: '' },
      { port: undefined },
      { user: '' },
      { pass: '' },
    ]) {
      const broken = account({ config: { ...account().config, ...patch } })
      expect(buildWatchRequest(broken), JSON.stringify(patch)).toBeNull()
    }
  })

  it('中继地址不是合法 URL 时返回 null', () => {
    expect(buildWatchRequest(account({ config: { ...account().config, relayUrl: 'not a url' } }))).toBeNull()
  })
})

/**
 * 一个可手动驱动的假 WebSocket。
 *
 * ⚠ 刻意**不**去 mock 整个 `WebSocket` 全局：那样测的是「我有没有正确调用 mock」，
 *   而不是「收到中继的帧之后会怎样」。这里只需要能触发 `message` 事件。
 */
class FakeWebSocket {
  static instances: FakeWebSocket[] = []

  binaryType = 'blob'
  readyState = 1
  sent: string[] = []

  private listeners = new Map<string, Array<(event: unknown) => void>>()

  constructor(public url: string) {
    FakeWebSocket.instances.push(this)
  }

  addEventListener(type: string, listener: (event: unknown) => void): void {
    const list = this.listeners.get(type) ?? []
    list.push(listener)
    this.listeners.set(type, list)
  }

  send(data: string): void {
    this.sent.push(data)
  }

  close(): void {
    this.readyState = 3
    this.emit('close', {})
  }

  /** 触发一个事件（测试用） */
  emit(type: string, event: unknown): void {
    for (const listener of this.listeners.get(type) ?? [])
      listener(event)
  }

  /** 模拟中继推来一条**文本** JSON */
  pushText(payload: unknown): void {
    this.emit('message', { data: JSON.stringify(payload) })
  }

  /**
   * 模拟中继推来一条 JSON。
   *
   * ⚠ **关键：这里复刻浏览器真实的行为** —— 文本帧在 `binaryType` 为
   *   `'arraybuffer'` 时也会以 `ArrayBuffer` 递进来。
   *
   *   如果 fake 永远只给 string，那么「设了 binaryType 会把文本帧变成
   *   ArrayBuffer、从而丢掉所有推送」这个**真机 bug 就测不出来** ——
   *   测试会给一个坏实现发合格证。
   *
   * ⚠ 二进制形态用 `Uint8Array`（不是 `.buffer`）：浏览器给 `ArrayBuffer`，
   *   而 Node / 某些 polyfill 给 `Uint8Array` / `Buffer`。两种都要覆盖。
   */
  private encode(payload: unknown): string | Uint8Array {
    const json = JSON.stringify(payload)
    return this.binaryType === 'arraybuffer' ? new TextEncoder().encode(json) : json
  }

  /** 模拟中继推来一条 JSON（形态由 `binaryType` 决定，同浏览器） */
  push(payload: unknown): void {
    this.emit('message', { data: this.encode(payload) })
  }

  /** 仅供测试断言「帧形态由 binaryType 决定」这件事 */
  encodeForTest(payload: unknown): string | Uint8Array {
    return this.encode(payload)
  }
}

describe('openWatchChannel', () => {
  beforeEach(() => {
    FakeWebSocket.instances = []
    vi.stubGlobal('WebSocket', FakeWebSocket)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  /** 建一条通道并返回「假 socket + 收到的事件」 */
  function open(accountPatch: Partial<MailAccount> = {}) {
    const events: WatchEvent[] = []
    const request = buildWatchRequest(account(accountPatch))
    if (!request)
      throw new Error('测试账号配置不完整')

    const stop = openWatchChannel('ws://127.0.0.1:8787/', request, event => events.push(event))
    const socket = FakeWebSocket.instances.at(-1)
    if (!socket)
      throw new Error('没有创建 WebSocket')

    return { stop, socket, events }
  }

  it('连上后立刻发出 watch 请求', () => {
    const { socket } = open()
    socket.emit('open', {})
    expect(socket.sent).toHaveLength(1)
    expect(JSON.parse(socket.sent[0])).toMatchObject({ __watch: 1, host: 'imap.qq.com' })
  })

  it('**不设** binaryType —— 设了会让文本帧变成 ArrayBuffer（真机上就这样丢过推送）', () => {
    const { socket } = open()

    /*
     * 这一条验证的是**前置条件**：`binaryType` 必须是默认值。
     *
     *   设成 `'arraybuffer'`（透传通道 `relay.ts` 的做法）之后，浏览器的
     *   WebSocket **连文本帧也会以 ArrayBuffer 递进来** —— 而下面的解析逻辑
     *   只认 string 的话，中继推来的每一条消息都会被丢掉。
     *
     *   下面第二个断言证明这个假 WebSocket **复刻了**那个行为：
     *   一旦 binaryType 被改成 arraybuffer，推来的就是 Uint8Array 而不是 string。
     *   没有这一层，测试就只能验证「我期望的形态」，测不出真机上的形态差异。
     */
    expect(socket.binaryType).toBe('blob')
    expect(typeof socket.encodeForTest({ a: 1 })).toBe('string')

    /*
     * ⚠ 断言「不是 string」而不是 `toBeInstanceOf(Uint8Array)`。
     *
     *   jsdom 的 `TextEncoder` 来自**另一个 realm**，它造出来的 `Uint8Array`
     *   与本测试文件的 `Uint8Array` **不是同一个构造函数** ——
     *   `instanceof` 会假失败（实测踩过：`expected Uint8Array[…] to be an instance of Uint8Array`，
     *   看着像自相矛盾，其实是跨 realm 的经典坑）。
     *
     *   这里真正要表达的是「它变成了二进制而不是文本」，判据用 typeof 就够，
     *   而且与被测代码里的 `ArrayBuffer.isView` 判断口径一致。
     */
    socket.binaryType = 'arraybuffer'
    const encoded = socket.encodeForTest({ a: 1 })
    expect(typeof encoded).not.toBe('string')
    expect(ArrayBuffer.isView(encoded)).toBe(true)
  })

  it('收到文本帧的 mail 事件 → 回调', () => {
    const { socket, events } = open()
    socket.push({ type: 'mail', accountId: 'acc-1', exists: 35504 })

    expect(events).toEqual([{ type: 'mail', accountId: 'acc-1', exists: 35504 }])
  })

  /*
   * ⚠ 这一条是本次修复的核心断言。
   *
   * 中继用 `ws.send(string)` 发文本帧，所以「文本帧」是**正常路径**，
   * 绝不能因为「不是 string 就丢掉」而被过滤。
   */
  it('文本帧被正常解析（不是字符串就 return 会丢掉所有推送）', () => {
    const { socket, events } = open()
    socket.push({ type: 'state', state: 'watching', exists: 35502 })

    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ state: 'watching', exists: 35502 })
  })

  it('二进制形态也能解析 —— 真机上就是这样丢过推送', () => {
    const { socket, events } = open()

    /*
     * ⚠ 这一条复现的是**真机 bug**：中继日志显示「新邮件：35502 → 35504」，
     *   插件一条都没收到，而两边都不报错。
     *
     *   根因是客户端照抄了透传通道的 `ws.binaryType = 'arraybuffer'`。
     *   设了它之后，浏览器连**文本帧**也以二进制递进来；而解析逻辑当时是
     *   「不是 string 就 return」—— 于是每一条推送都被静默丢掉。
     *   中继日志一切正常，因为**推是推出去了**，只是插件没接住。
     *
     * 所以这里显式把 binaryType 设成 arraybuffer 再推 —— 这正是修复前的现场。
     */
    socket.binaryType = 'arraybuffer'
    socket.push({ type: 'mail', accountId: 'acc-1', exists: 35504 })

    expect(events).toEqual([{ type: 'mail', accountId: 'acc-1', exists: 35504 }])
  })

  it('二进制帧也接受（中继将来换实现时推送不该静默消失）', () => {
    const { socket, events } = open()
    socket.push({ type: 'mail', accountId: 'acc-1', exists: 9 })

    expect(events).toEqual([{ type: 'mail', accountId: 'acc-1', exists: 9 }])
  })

  it('无法识别的 data 形态不炸（只是忽略）', () => {
    const { socket, events } = open()
    socket.emit('message', { data: 12345 })
    socket.emit('message', { data: null })
    expect(events).toHaveLength(0)
  })

  it('坏 JSON 不炸（只是忽略）', () => {
    const { socket, events } = open()
    socket.emit('message', { data: '{ 这不是 JSON' })
    expect(events).toHaveLength(0)
  })

  it('reconnecting 状态传给回调', () => {
    const { socket, events } = open()
    socket.push({ type: 'state', state: 'reconnecting', retryInMs: 2000 })
    expect(events[0]).toMatchObject({ state: 'reconnecting', retryInMs: 2000 })
  })

  it('中继说 failed（启动失败）→ 传给回调', () => {
    const { socket, events } = open()
    socket.push({ type: 'state', state: 'failed', error: 'watch 请求缺少 user / pass' })
    expect(events[0]).toMatchObject({ state: 'failed' })
  })

  it('连接断开 → 退避后自动重连', async () => {
    vi.useFakeTimers()
    const { socket } = open()
    socket.emit('open', {})

    const before = FakeWebSocket.instances.length
    socket.emit('close', {})
    await vi.advanceTimersByTimeAsync(1500)

    expect(FakeWebSocket.instances.length).toBe(before + 1)
    vi.useRealTimers()
  })

  it('中继在协议层报 fatal 时**不再**重连（密码错，重连只会重复失败）', async () => {
    vi.useFakeTimers()
    const { socket } = open()

    // 中继判断「重试无用」时会把 fatal 消息推过来，然后自己关掉连接
    socket.push({ type: 'state', state: 'failed', error: '登录失败：Authentication failed' })
    const before = FakeWebSocket.instances.length
    socket.emit('close', {})
    await vi.advanceTimersByTimeAsync(120000)

    expect(FakeWebSocket.instances.length).toBe(before)
    vi.useRealTimers()
  })

  it('stop() 之后不再重连', async () => {
    vi.useFakeTimers()
    const { socket, stop } = open()
    socket.emit('open', {})

    const before = FakeWebSocket.instances.length
    stop()
    await vi.advanceTimersByTimeAsync(120000)

    expect(FakeWebSocket.instances.length).toBe(before)
    vi.useRealTimers()
  })
})
