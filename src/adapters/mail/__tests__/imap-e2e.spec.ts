// @vitest-environment node
//
// ⚠ 这一行是**必需的**，不是装饰：本文件要起真的 Node TCP server 与子进程，
//   而默认的 jsdom 环境会往全局塞它自己的 `Event` / `EventTarget`。
//   Node 的 `net.Socket` 内部断言事件是 Node 的 `Event` 实例，于是 `socket.write()`
//   直接抛 `ERR_INVALID_ARG_TYPE: The "event" argument must be an instance of Event` ——
//   症状是「mock 服务器收到命令但一个字都不回」，客户端一直等到超时。
//   排查时它看起来像 IMAP 协议问题，其实是测试环境问题。
//
//   不要试图用 `environmentMatchGlobs` 在 vite.config.mts 里配：那个选项在
//   Vitest 5 已被移除，留着它是**静默失效**的。

import type { MailPipeline } from '~/logic/ai/pipeline'
import type { Mail, MailAccount } from '~/logic/types'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { syncWithProvider } from '~/adapters/mail/mailbox'
import { create as createImapProvider } from '~/adapters/mail/providers/imap/index'
import { readAccount, upsertAccount } from '~/logic/store/accounts'
import { readMailsByAccount, upsertMail } from '~/logic/store/mails'
import { MAILBOX, startMockImapServer } from '../testing/mock-imap-server'
import { startRelayForTest } from '../testing/start-relay'

/**
 * **端到端**：真 IMAP provider → 真中继进程 → 真（虚构）IMAP 服务器 → 真 IDB。
 *
 * ## 为什么必须有这一层
 *
 * 单测里的 provider 是假的，所以它只验「编排逻辑」；而真机上出的问题恰恰在
 * **协议往返**那一层 —— 字面量长度按字符还是按字节、`SEARCH` 响应怎么切、
 * 命令超时怎么算、游标推进与「本批」的关系。这些在假 provider 上永远测不出来。
 *
 * 这一层跑的是扩展**同一份**代码：
 *   - `providers/imap/`（自研 IMAP 客户端）
 *   - `transport/relay.ts`（WebSocket 那一段）
 *   - `scripts/imap-relay.mjs`（**真中继进程**，真 TCP 到 mock 服务器）
 *   - `mailbox.ts` + `store/*` + fake-indexeddb
 *
 * 唯一被替换掉的是「邮件服务器」本身，以及 AI 那一段（用假 pipeline）。
 */

const RELAY_PORT = 18991
const IMAP_PORT = 19143

async function startRelay(): Promise<import('node:child_process').ChildProcess> {
  /*
   * ⚠ 必须经 `startRelayForTest`（它用 esno 跑 `.ts`）——
   *   Node 不认 `.ts`，直接 spawn 会得到「中继启动超时」，指不到真正的原因。
   */
  return startRelayForTest(RELAY_PORT, { ALLOWED_HOSTS: '127.0.0.1' })
}

function makeAccount(patch: Partial<MailAccount> = {}): MailAccount {
  return {
    id: 'acc-e2e',
    label: '虚构邮箱',
    email: 'me@example.com',
    provider: 'imap',
    config: {
      host: '127.0.0.1',
      port: IMAP_PORT,
      /*
       * ⚠ 这里必须是 `tls: false`：mock 服务器是**明文 TCP**，
       *   而 `tls: true` + 993 会被中继直接拒（那是刻意的保护，
       *   见 relay 的 `993 端口是 implicit TLS，必须开启 TLS`）。
       *   真实 TLS 往返由 `pnpm relay:test` 用自签证书单独覆盖。
       */
      tls: false,
      user: 'me@example.com',
      pass: 'secret',
      relayUrl: `ws://127.0.0.1:${RELAY_PORT}/`,
    },
    blockedList: [],
    enabled: true,
    createdAt: 1,
    cursor: null,
    ...patch,
  }
}

/** 假的 AI 流水线：把邮件真的写进库，但不调 AI */
function fakePipeline() {
  const seen: Mail[] = []
  const pipeline: MailPipeline = {
    async readSettingsForFilter() {
      return { minimalMode: false, blockedEnabled: true }
    },
    async process(mail) {
      seen.push(mail)
      await upsertMail(mail, 'unlimited')
      return 'saved'
    },
  }
  return { pipeline, seen }
}

let relay: import('node:child_process').ChildProcess
let mockServer: import('node:net').Server

beforeAll(async () => {
  mockServer = await startMockImapServer(IMAP_PORT, { verbose: true })
  relay = await startRelay()
}, 25000)

afterAll(() => {
  relay?.kill()
  mockServer?.close()
})

/**
 * ⚠ 每个用例都自己建账号，**不要**在用例之间传递状态。
 *
 * `src/tests/setup.ts` 的 `beforeEach` 每个用例前都会删库（否则用例互相污染），
 * 所以「第一个用例建账号、第二个用例读它」这种写法第二个用例必然拿到
 * `undefined`（报错还会是 `Cannot read properties of undefined (reading 'config')`
 * 这种指不到根因的形态）。需要「已同步过」的状态，就把游标直接喂进账号对象。
 */
function accountWithCursor(uid: number): MailAccount {
  return makeAccount({ cursor: { uid, uidValidity: MAILBOX.uidValidity } })
}

describe('端到端：真 IMAP 协议往返', () => {
  it('首次同步：只记游标，一封都不拉', async () => {
    const account = makeAccount()
    await upsertAccount(account)

    const { pipeline, seen } = fakePipeline()
    const result = await syncWithProvider(account, createImapProvider(), pipeline)

    expect(result.firstSync).toBe(true)
    expect(result.fetched).toBe(0)
    expect(seen).toHaveLength(0)

    const stored = await readAccount(account.id)
    // UIDNEXT = 最大 UID + 1 → 游标落在最大 UID 上
    expect(stored?.cursor).toMatchObject({ uid: MAILBOX.uidNext - 1, uidValidity: MAILBOX.uidValidity })
  }, 30000)

  it('增量同步：拉到那 2 封，正文按**字节**长度正确解析', async () => {
    // 模拟「已经同步到 37727」的状态
    const account = accountWithCursor(37727)
    await upsertAccount(account)

    const { pipeline, seen } = fakePipeline()
    const result = await syncWithProvider(account, createImapProvider(), pipeline, { retention: 'unlimited' })

    expect(result.firstSync).toBe(false)
    expect(result.fetched).toBe(2)
    expect(seen.map(mail => mail.subject)).toEqual(['第一封新邮件', '第二封新邮件'])

    /*
     * 正文完整性是这一条的核心：IMAP 的字面量长度是**字节数**，
     * 若代码按字符算（中文一个字符 3 字节），这里会截断、或把后续响应的字节混进来。
     */
    expect(seen[0].bodyText).toContain('UID 37728')
    expect(seen[1].bodyText).toContain('482913')

    expect(await readMailsByAccount(account.id)).toHaveLength(2)
    // 游标推进到本批最大 UID
    expect((await readAccount(account.id))?.cursor).toMatchObject({ uid: 37729 })
  }, 30000)

  it('没有新邮件时：游标推到 UIDNEXT-1，且不重复拉取', async () => {
    const account = accountWithCursor(MAILBOX.lastUid)
    await upsertAccount(account)

    const { pipeline, seen } = fakePipeline()
    const result = await syncWithProvider(account, createImapProvider(), pipeline, { retention: 'unlimited' })

    expect(result.fetched).toBe(0)
    expect(seen).toHaveLength(0)
    expect((await readAccount(account.id))?.cursor).toMatchObject({ uid: MAILBOX.uidNext - 1 })
  }, 30000)

  it('已同步过的账号再同步时不会重复入库（账本键稳定）', async () => {
    const account = accountWithCursor(37727)
    await upsertAccount(account)

    await syncWithProvider(account, createImapProvider(), fakePipeline().pipeline, { retention: 'unlimited' })
    expect(await readMailsByAccount(account.id)).toHaveLength(2)

    // 第二轮：游标已推进，一封都不该再拉
    const fresh = (await readAccount(account.id))!
    const second = await syncWithProvider(fresh, createImapProvider(), fakePipeline().pipeline, { retention: 'unlimited' })
    expect(second.fetched).toBe(0)
    expect(await readMailsByAccount(account.id)).toHaveLength(2)
  }, 30000)

  it('没填中继地址时给出可操作的错误，而不是等到超时', async () => {
    const account = makeAccount({ config: { ...makeAccount().config, relayUrl: '' } })
    await upsertAccount(account)

    const { pipeline } = fakePipeline()
    await expect(syncWithProvider(account, createImapProvider(), pipeline))
      .rejects
      .toThrow(/裸 TCP|中继/)
  }, 20000)

  it('连不上中继时（端口没人监听）报错，而不是永久挂起', async () => {
    const account = makeAccount({
      config: { ...makeAccount().config, relayUrl: 'ws://127.0.0.1:18999/' },
    })
    await upsertAccount(account)

    // 18999 上没有任何东西在监听 —— 必须快速失败
    await expect(
      syncWithProvider(account, createImapProvider(), fakePipeline().pipeline),
    ).rejects.toThrow()
  }, 20000)
})
