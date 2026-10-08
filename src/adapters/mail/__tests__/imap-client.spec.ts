import { describe, expect, it } from 'vitest'
import { ImapClient, readLiteralLength } from '~/adapters/mail/providers/imap/client'

/**
 * IMAP 客户端的**积压处理**测试。
 *
 * 对应一个真机故障：用户的 QQ 邮箱有 35492 封邮件、游标在 UID 37727，
 * 点「立即同步增量」后 UI 报「请求超时」。根因是当时的实现用
 * `UID FETCH <cursor+1>:*` —— 服务器会把游标之后**所有**邮件正文都发过来
 * （积压几千封就是几千次 `BODY.PEEK[]`），必然撞爆 30 秒命令超时；
 * 而且它保留的是**最新**的 50 封、把游标推到 UIDNEXT-1，中间那几千封**永久丢失**。
 *
 * 修法：先 `UID SEARCH` 拿 UID 列表（只有整数），再 `UID FETCH a:b`
 * 只取**最旧**的一批。这里用假的 `MailSocket` 验证命令真的是这么发的。
 *
 * ⚠ 每个假响应里都必须带 `<tag> OK`：IMAP 客户端靠带标记的响应判断命令结束，
 *   只回未标记的 `*` 行会让它一直等下去（测试表现为超时，看不出原因）。
 */

type Socket = import('~/adapters/mail/transport/types').MailSocket & { written: string[] }

/** 一个可编排的假 IMAP 服务器 */
function fakeSocket(handler: (command: string) => string[]): Socket {
  const written: string[] = []
  const inbound: Uint8Array[] = []
  const encoder = new TextEncoder()
  let closed = false
  let waiter: ((value: Uint8Array | null) => void) | null = null

  function flush(): void {
    if (!waiter)
      return
    if (inbound.length) {
      const resolve = waiter
      waiter = null
      resolve(inbound.shift()!)
      return
    }
    if (closed) {
      const resolve = waiter
      waiter = null
      resolve(null)
    }
  }

  const socket = {
    written,
    get closed() {
      return closed
    },
    read(): Promise<Uint8Array | null> {
      const chunk = inbound.shift()
      if (chunk)
        return Promise.resolve(chunk)
      if (closed)
        return Promise.resolve(null)
      return new Promise<Uint8Array | null>((resolve) => {
        waiter = resolve
      })
    },
    write(data: Uint8Array): void {
      // 逐行处理：一条 write 里可能有多条命令
      for (const line of new TextDecoder().decode(data).split('\r\n').filter(Boolean)) {
        written.push(line)
        for (const reply of handler(line))
          inbound.push(encoder.encode(reply))
      }
      flush()
    },
    close(): void {
      closed = true
      flush()
    },
  }

  return socket as unknown as Socket
}

/**
 * 自动应答 LOGIN / SELECT 的 handler。
 *
 * 每个用例只关心它要验的那条命令，登录与选箱用默认应答 —— 否则每个 handler 都要
 * 抄一遍那两行，而抄错的表现是「测试超时」这种毫无指向性的报错。
 */
function imapHandler(options: { search?: string, fetch?: string[] } = {}) {
  return (line: string): string[] => {
    // 标记必须与请求一致（客户端靠它判断命令结束）
    const tag = line.split(' ')[0]
    const ok = `${tag} OK done\r\n`

    if (line.includes('LOGIN'))
      return [`${tag} OK LOGIN completed\r\n`]
    if (line.includes('SELECT'))
      return ['* 0 EXISTS\r\n', `${tag} OK [READ-WRITE] SELECT completed\r\n`]
    if (line.includes('UID SEARCH'))
      return [`* SEARCH${options.search ? ` ${options.search}` : ''}\r\n`, ok]
    if (line.includes('UID FETCH'))
      return [...(options.fetch ?? []), ok]
    return [ok]
  }
}

async function loggedInClient(handler: (command: string) => string[]) {
  const socket = fakeSocket(handler)
  const client = new ImapClient(socket, { commandTimeoutMs: 1000 })

  // 走完 LOGIN + SELECT，让客户端进入可用状态
  await client.login('u', 'p')
  await client.selectInbox()
  return { client, socket }
}

const BACKLOG_START = 37728

describe('readLiteralLength', () => {
  it('识别同步字面量 {N}', () => {
    expect(readLiteralLength('* 1 FETCH (UID 1 BODY[] {42}')).toBe(42)
  })

  it('识别非同步字面量 {N+}（LITERAL+ 扩展）', () => {
    expect(readLiteralLength('* 1 FETCH (UID 1 BODY[] {42+}')).toBe(42)
  })

  it('行尾没有字面量标记时返回 null', () => {
    expect(readLiteralLength('* 1 FETCH (UID 1 FLAGS ())')).toBeNull()
    expect(readLiteralLength('{abc}')).toBeNull()
  })
})

describe('searchSince', () => {
  it('只发 SEARCH、不发 FETCH —— 这是「不占带宽」的全部意义', async () => {
    const { client, socket } = await loggedInClient(imapHandler({ search: '100 101 102' }))

    expect(await client.searchSince(99)).toEqual([100, 101, 102])

    const sent = socket.written.join('\n')
    expect(sent).toContain('UID SEARCH UID 100:*')
    expect(sent).not.toContain('FETCH')
  })

  it('过滤掉 <= sinceUid 的项（`a:*` 在 a 超出末尾时会回最大的那个 UID）', async () => {
    const { client } = await loggedInClient(imapHandler({ search: '50 99' }))
    expect(await client.searchSince(99)).toEqual([])
  })

  it('空结果是合法的（`* SEARCH` 后面什么都没有）', async () => {
    const { client } = await loggedInClient(imapHandler({ search: '' }))
    expect(await client.searchSince(99)).toEqual([])
  })
})

describe('fetchRange', () => {
  it('发的是确定区间 `a:b`，而不是 `a:*`', async () => {
    const { client, socket } = await loggedInClient(imapHandler())

    await client.fetchRange(100, 149)

    const sent = socket.written.join('\n')
    expect(sent).toContain('UID FETCH 100:149')
    expect(sent).not.toContain('UID FETCH 100:*')
  })

  it('区间为空时直接返回，不发任何命令', async () => {
    const { client, socket } = await loggedInClient(imapHandler())
    socket.written.length = 0

    expect(await client.fetchRange(200, 199)).toEqual([])
    expect(socket.written).toHaveLength(0)
  })
})

describe('字面量解析（正文靠它拿到）', () => {
  it('按 {N} 精确读 N 字节，且不把二进制当语法解析', async () => {
    // 正文里故意放 CRLF 与非 ASCII —— 按行读会在这里崩
    const body = 'Subject: hi\r\n\r\n你好\r\nmore'
    const size = new TextEncoder().encode(body).length

    const { client } = await loggedInClient(imapHandler({
      fetch: [
        // 第一行以 `{N}` 结尾，后面紧跟恰好 N 字节的正文
        `* 1 FETCH (UID 100 FLAGS (\\Seen) BODY[] {${size}}\r\n`,
        body,
        '\r\n)\r\n',
      ],
    }))

    const fetched = await client.fetchRange(100, 100)
    expect(fetched).toHaveLength(1)
    expect(fetched[0].uid).toBe(100)
    expect(fetched[0].flags).toEqual(['Seen'])
    expect(new TextDecoder().decode(fetched[0].source)).toBe(body)
  })
})

describe('select 拿到的状态', () => {
  it('解析 UIDNEXT / UIDVALIDITY / EXISTS（用户那份真实数据）', async () => {
    const socket = fakeSocket((line) => {
      const tag = line.split(' ')[0]
      if (line.includes('SELECT')) {
        return [
          '* 35492 EXISTS\r\n',
          '* OK [UIDVALIDITY 1366601569] UIDs valid\r\n',
          '* OK [UIDNEXT 37728] Predicted next UID\r\n',
          `${tag} OK [READ-WRITE] SELECT completed\r\n`,
        ]
      }
      return [`${tag} OK done\r\n`]
    })
    const client = new ImapClient(socket, { commandTimeoutMs: 1000 })
    await client.login('u', 'p')

    expect(await client.selectInbox()).toEqual({
      exists: 35492,
      uidValidity: 1366601569,
      uidNext: 37728,
    })
  })
})

describe('积压回归：取最旧的一批，而不是最新的', () => {
  it('先 SEARCH 拿全量 UID，再只 FETCH 最旧的 50 个', async () => {
    /*
     * 这一条把「取最旧而不是最新」钉死。
     *
     * 取最新会让游标直接跳到末尾，中间那几千封**永久丢失** ——
     * 而界面上看不出任何异常（同步「成功」了，只是少了邮件）。
     */
    const backlog = Array.from({ length: 5000 }, (_, i) => BACKLOG_START + i)

    const { client, socket } = await loggedInClient(imapHandler({ search: backlog.join(' ') }))

    const uids = await client.searchSince(37727)
    expect(uids).toHaveLength(5000)

    // provider 的取批逻辑：`backlog.slice(0, 50)`
    const batch = uids.slice(0, 50)
    expect(batch[0]).toBe(37728)
    expect(batch[batch.length - 1]).toBe(37777)

    await client.fetchRange(batch[0], batch[batch.length - 1])

    const sent = socket.written.join('\n')
    expect(sent).toContain('UID FETCH 37728:37777')
    /*
     * 关键：没有对整段积压发起传输。
     *
     * ⚠ 这里不能写 `expect(sent).not.toContain('37728:*')` —— `UID SEARCH UID 37728:*`
     *   里**本来就**含这个子串（SEARCH 的 `a:*` 是正确用法，它只回整数）。
     *   会误报的断言比没有断言更糟：它逼着后来的人去改正确代码。
     *   要断言的是「FETCH 没用开放式区间」。
     */
    expect(sent).not.toContain('UID FETCH 37728:*')
    expect(sent).not.toContain('UID FETCH 37728:42727')
  })
})
