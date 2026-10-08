// @vitest-environment node
//
// ⚠ 这一行是**必需的**：本文件要起真的 Node TCP server 与子进程，而默认的 jsdom
//   会往全局塞它自己的 `Event` / `EventTarget`，Node 的 `net.Socket` 内部断言事件是
//   Node 的 `Event` 实例 —— 于是 `socket.write()` 直接抛
//   `ERR_INVALID_ARG_TYPE`，症状是「服务器收到命令但一个字都不回」。

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { WebSocket } from 'ws'
import { deliverNewMail, MAILBOX, resetMockImap, startMockImapServer, VALID_CREDENTIALS } from '../testing/mock-imap-server'
import { startRelayForTest } from '../testing/start-relay'

/**
 * **端到端**：真 WebSocket → 真中继进程（watch 模式）→ 真（虚构）IMAP 服务器。
 *
 * ## 这一组在防什么
 *
 * 中继的 watch 模式是整个「实时收信」的地基：它替插件挂住常驻 `IDLE`，
 * 有新邮件就推一行过去。它写错的后果是**静默的** ——
 * 插件还在正常同步（有兜底定时器），只是「实时」不再实时，
 * 而界面上不会显示任何异常。所以必须把这些行为钉死：
 *
 *   - `IDLE` 的握手是 `+ idling` 而不是 `OK`（写错会在真机上被服务器拒）
 *   - 只在 `EXISTS` **变大**时推（否则每轮 NOOP 都推，变成刷屏）
 *   - 推送里**不带邮件内容**（带了就等于中继开始解析邮件了）
 *   - 认证失败**不重试**（重试会把账号锁掉）
 *   - 客户端断开后中继**停止监听**（否则连接泄漏，攒多了会把邮件服务器连接数占满）
 */

const RELAY_PORT = 18992
const IMAP_PORT = 19144

/** 启动中继进程并等它就绪 */
async function startRelay(): Promise<import('node:child_process').ChildProcess> {
  /*
   * ⚠ 必须经 `startRelayForTest`（它用 esno 跑 `.ts`）——
   *   Node 不认 `.ts`，直接 spawn 会得到「中继启动超时」，指不到真正的原因。
   */
  return startRelayForTest(RELAY_PORT)
}

let relay: import('node:child_process').ChildProcess
let mockServer: import('node:net').Server

beforeAll(async () => {
  mockServer = await startMockImapServer(IMAP_PORT)
  relay = await startRelay()
}, 25000)

beforeEach(() => {
  resetMockImap()
})

afterAll(() => {
  relay?.kill()
  mockServer?.close()
})

/** 一个连上中继并发出 watch 请求的客户端，附带「收到过哪些消息」的记录 */
interface WatchClient {
  /** 收到过的所有消息（按到达顺序） */
  messages: Array<Record<string, unknown>>
  /** 等到某条满足条件的消息（超时抛错，避免测试挂死） */
  waitFor: (predicate: (message: Record<string, unknown>) => boolean, timeoutMs?: number) => Promise<Record<string, unknown>>
  close: () => void
}

function openWatchClient(patch: Record<string, unknown> = {}): Promise<WatchClient> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${RELAY_PORT}/`)
    const messages: Array<Record<string, unknown>> = []
    const waiters: Array<{ predicate: (message: Record<string, unknown>) => boolean, resolve: (message: Record<string, unknown>) => void }> = []

    ws.on('message', (data) => {
      let parsed: Record<string, unknown>
      try {
        parsed = JSON.parse(data.toString())
      }
      catch {
        return
      }
      messages.push(parsed)
      for (let i = waiters.length - 1; i >= 0; i--) {
        if (waiters[i].predicate(parsed)) {
          waiters[i].resolve(parsed)
          waiters.splice(i, 1)
        }
      }
    })

    ws.on('error', reject)

    ws.on('open', () => {
      ws.send(JSON.stringify({
        __watch: 1,
        accountId: 'acc-watch',
        host: '127.0.0.1',
        port: IMAP_PORT,
        // mock 服务器是明文 TCP
        tls: false,
        user: VALID_CREDENTIALS.user,
        pass: VALID_CREDENTIALS.pass,
        ...patch,
      }))

      resolve({
        messages,
        waitFor(predicate, timeoutMs = 5000) {
          const existing = messages.find(predicate)
          if (existing)
            return Promise.resolve(existing)
          return new Promise((resolveWait, rejectWait) => {
            const timer = setTimeout(() => {
              rejectWait(new Error(`等待超时。已收到的消息：${JSON.stringify(messages)}`))
            }, timeoutMs)
            waiters.push({
              predicate,
              resolve: (message) => {
                clearTimeout(timer)
                resolveWait(message)
              },
            })
          })
        },
        close: () => ws.close(),
      })
    })
  })
}

/**
 * 中继进程输出的累积日志。
 *
 * ⚠ **只用来判断「某个时刻之后有没有新行」**，不要拿它做计数断言。
 *   它是整个测试文件共享的累积缓冲区，跨用例累加 —— 直接比较两次
 *   「总行数」会因为别的用例也在写而失败（实测就是这样误报过一次）。
 *
 * 用法：先 `markOutput()` 取一个基线，再比较之后有没有包含特定内容。
 */
let relayOutput = ''
/** 当前日志长度（作为「之后有没有新内容」的基线） */
function outputMark(): number {
  return relayOutput.length
}

/** 清空累积日志（用例开始前调用，让断言只看这一段） */
function clearOutput(): void {
  relayOutput = ''
}

beforeAll(() => {
  // 类型由 Node 的 `Readable` 重载给出，不用手写 `chunk: Buffer`
  relay.stdout?.on('data', (chunk) => {
    relayOutput += chunk.toString()
  })
  relay.stderr?.on('data', (chunk) => {
    relayOutput += chunk.toString()
  })
})

describe('中继 watch：常驻监听', () => {
  it('挂上 IDLE 后回一条 watching 状态（带当前邮件数）', async () => {
    const client = await openWatchClient()

    const state = await client.waitFor(message => message.type === 'state' && message.state === 'watching')
    expect(state.exists).toBe(MAILBOX.messages.size)

    client.close()
  }, 20000)

  it('新邮件到达 → 推出 mail 事件，且带的是邮件总数', async () => {
    const client = await openWatchClient()
    await client.waitFor(message => message.state === 'watching')

    // 等中继真的挂上 IDLE 再推 —— 否则这条未标记响应会落在 SELECT 之前
    await new Promise(resolve => setTimeout(resolve, 150))

    const expected = deliverNewMail(1)
    expect(expected).toBeGreaterThan(0)

    const mail = await client.waitFor(message => message.type === 'mail')
    expect(mail.exists).toBe(expected)
    // 推送里**不带**邮件内容 —— 中继不该解析邮件
    expect(Object.keys(mail).sort()).toEqual(['accountId', 'exists', 'type'])

    client.close()
  }, 20000)

  it('连来两封 → 推两次（不是合并成一次）', async () => {
    const client = await openWatchClient()
    await client.waitFor(message => message.state === 'watching')
    await new Promise(resolve => setTimeout(resolve, 150))

    const first = deliverNewMail(1)
    await client.waitFor(message => message.type === 'mail' && message.exists === first)

    const second = deliverNewMail(1)
    await client.waitFor(message => message.type === 'mail' && message.exists === second)

    expect(second).toBe(first + 1)
    expect(client.messages.filter(message => message.type === 'mail')).toHaveLength(2)

    client.close()
  }, 20000)

  it('iDLE 期间服务器回一条重复的 EXISTS（没有新邮件）→ 不推', async () => {
    const client = await openWatchClient()
    await client.waitFor(message => message.state === 'watching')
    await new Promise(resolve => setTimeout(resolve, 150))

    /*
     * ⚠ 这条防的是「刷屏」：如果判据是「收到 EXISTS 就推」而不是「EXISTS 变大」，
     *   那么服务器任何一次状态回执都会让插件白跑一轮同步。
     *
     *   这里直接推一个**和当前相同**的数 —— 用 count=0 让 exists 不变。
     */
    deliverNewMail(0)
    await new Promise(resolve => setTimeout(resolve, 400))

    expect(client.messages.filter(message => message.type === 'mail')).toHaveLength(0)

    client.close()
  }, 20000)

  it('密码错 → 推 failed 状态，并且不重试', async () => {
    /*
     * ⚠ 先清空累积日志，让下面的断言只看**这一个用例**产生的输出。
     *
     *   日志缓冲区是整个文件共享的、跨用例累加 —— 不清空的话，
     *   「之后有没有新的重试」会被别的用例（以及它们的收尾日志）污染。
     */
    clearOutput()

    const client = await openWatchClient({ pass: 'wrong-password' })

    const failed = await client.waitFor(message => message.state === 'failed')
    expect(String(failed.error)).toContain('登录失败')

    /*
     * ⚠ 认证失败**必须**不重试：密码错时快速重连会让服务器把账号锁掉
     *   （QQ 会直接拒连一段时间），而用户只看到一串无意义的失败日志。
     *
     * ⚠ 判据是「有没有**重新开始监听**」，而不是「日志里有没有 WATCH 这个词」。
     *   中继的每条 watch 日志都带 `WATCH <host>:<port>` 前缀 ——
     *   **包括「停止重试」和「结束」这两条**。用 `not.toContain('WATCH')` 断言，
     *   会在**正确行为**下失败（实测踩过一次，白白怀疑了半天正确代码）。
     *   真正的重试信号是「又出现一次 `开始常驻监听`」。
     */
    const mark = outputMark()
    await new Promise(resolve => setTimeout(resolve, 2500))
    const afterFailure = relayOutput.slice(mark)

    expect(afterFailure).not.toContain('开始常驻监听')
    expect(afterFailure).not.toContain('reconnecting')
    expect(relayOutput).toContain('停止重试')

    /*
     * 客户端也**不该**收到 reconnecting 状态 —— 插件侧据此显示「正在重连」，
     * 而密码错时重连永远不会成功，只会让用户以为还有希望。
     */
    expect(client.messages.filter(message => message.state === 'reconnecting')).toHaveLength(0)

    client.close()
  }, 20000)

  it('客户端断开 → 中继不崩、也不再往那条连接推邮件', async () => {
    const client = await openWatchClient()
    await client.waitFor(message => message.state === 'watching')
    await new Promise(resolve => setTimeout(resolve, 150))

    const received = client.messages.length
    client.close()

    /*
     * ⚠ 这里**不断言「中继多快打了『结束』日志」**。
     *
     *   那条日志的时机取决于「TCP 关闭事件 → watchOnce 收尾 → 主循环判断」三步，
     *   而这三步没有确定性的完成信号。用固定 `setTimeout` 去等它，写紧了就是
     *   **偶发失败**（实测单独跑过、跑全套时失败）—— 那种测试比没有更糟，
     *   它会让人开始怀疑正确的代码。
     *
     *   这一条真正要守住的是「断开之后不出事」：
     *     1. 中继进程还活着（watch 结束不能把整个进程带走）；
     *     2. 那条连接不再收到推送（没有悬挂的监听）。
     */
    await new Promise(resolve => setTimeout(resolve, 500))

    expect(relay.exitCode).toBeNull()

    // 断开后再推邮件：不该再有任何新消息到达（连接已经关了）
    deliverNewMail(1)
    await new Promise(resolve => setTimeout(resolve, 400))

    expect(client.messages).toHaveLength(received)
    expect(relay.exitCode).toBeNull()
  }, 20000)

  it('watch 请求缺字段 → 报错而不是静默不干活', async () => {
    const client = await openWatchClient({ user: '' })
    const failed = await client.waitFor(message => message.state === 'failed')
    expect(String(failed.error)).toContain('user')
    client.close()
  }, 20000)

  it('aLLOWED_HOSTS 之外的 host 在 watch 路径上也被拒', async () => {
    // 白名单是 127.0.0.1，这里请求一个别的 host
    const client = await openWatchClient({ host: 'imap.example.com' })
    const failed = await client.waitFor(message => message.state === 'failed')
    expect(String(failed.error)).toContain('not allowed')
    client.close()
  }, 20000)
})

afterEach(() => {
  // 每个用例结束后留一点时间让中继清理连接
})
