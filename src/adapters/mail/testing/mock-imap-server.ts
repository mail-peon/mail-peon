import { Buffer } from 'node:buffer'
import { createServer } from 'node:net'
import process from 'node:process'

/**
 * 一个**虚构的 IMAP 服务器**（测试用）。
 *
 * 存在的理由：真机上的问题（同步几十秒后 UI 收不到回执、积压不推进、正文被截断、
 * IDLE 挂不住）**没法靠假 provider 的单测定位** —— 问题恰恰出在「真客户端与实际
 * IMAP 应答之间的往返」上。这里起一个说 IMAP 的真服务器，于是字面量长度、
 * `SEARCH` 响应切分、命令超时、IDLE 的 `+ idling` / `DONE` 握手，都能在毫秒级验证。
 *
 * 只实现 mail-peon 真正会发的命令；其余一律回 `BAD` 并**打印出来** ——
 * 「客户端发了意料之外的东西」必须立刻可见，而不是被静默忽略。
 */

/**
 * 虚拟邮箱的内容。
 *
 * `UIDVALIDITY` / `UIDNEXT` 照抄一份真实邮箱的形状，好让断言里出现的是真实量级。
 */
export const MAILBOX = {
  uidValidity: 1366601569,
  /** UID → 邮件 */
  messages: new Map<number, { subject: string, body: string }>([
    [37728, { subject: '第一封新邮件', body: '这是 UID 37728 的正文。' }],
    [37729, { subject: '第二封新邮件', body: '这是 UID 37729 的正文，含验证码 482913。' }],
  ]),
  /** 已有邮件的最大 UID；首次同步的游标应落在它上面 */
  lastUid: 37729,
  get uidNext() {
    return this.lastUid + 1
  },
}

function rawMessage(uid: number, subject: string, body: string): string {
  return [
    'From: Mock Sender <mock@example.com>',
    'To: me@example.com',
    `Subject: ${subject}`,
    'Date: Wed, 15 Nov 2023 10:00:00 +0000',
    `Message-ID: <mock-${uid}@example.com>`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=utf-8',
    '',
    body,
  ].join('\r\n')
}

const encoder = new TextEncoder()

/** 一条连接的状态 */
interface ConnectionState {
  closed: boolean
  /** 是否处于 `IDLE`（`DONE` 之前不结束那条命令） */
  idling: boolean
  /** 是否 `SELECT` 过（`IDLE` 只允许在选中邮箱之后发） */
  selected: boolean
  /** 当前邮箱里有多少封 */
  exists: number
}

/** 正在 `IDLE` 的会话，`deliverNewMail()` 靠它推送 */
const idleSessions = new Set<{
  state: ConnectionState
  /** 直接往 socket 写一行（IDLE 期间的未标记响应） */
  emit: (line: string) => void
}>()

/**
 * 模拟「服务器收到了新邮件」。
 *
 * 这是测试 watch 的唯一手段：真机上服务器会主动发 `* n EXISTS`，测试里必须自己
 * 制造这个时刻。
 *
 * ⚠ 只推给**正在 IDLE** 的连接。IMAP 规定未标记响应只在命令执行期间发出；
 *   不在 IDLE 时推送等于伪造协议行为，那样测出来的「通过」没有意义。
 *
 * @param count 一次到达几封
 * @returns 推送后邮箱里的总数（没有任何 IDLE 会话时返回 -1）
 */
export function deliverNewMail(count = 1): number {
  let total = -1
  for (const session of idleSessions) {
    session.state.exists += count
    session.emit(`* ${session.state.exists} EXISTS\r\n`)
    total = session.state.exists
  }
  return total
}

/** 清空 IDLE 会话表（每个用例前调用，避免用例之间互相污染） */
export function resetMockImap(): void {
  idleSessions.clear()
}

/** 虚拟邮箱接受的凭据。用来验证「密码错」这条路径 */
export const VALID_CREDENTIALS = { user: 'me@example.com', pass: 'secret' }

/**
 * 处理一条命令行，返回要写回客户端的字节。
 *
 * ⚠ 每个响应都必须带**与请求一致的标记**再以 `OK` 结尾：客户端靠它判断命令结束，
 *   只回未标记的 `*` 行会让它一直等下去（表现为超时，看不出原因）。
 */
function handle(line: string, state: ConnectionState, onUnexpected: (line: string) => void): Uint8Array[] {
  const tag = line.split(' ')[0]
  const out: Uint8Array[] = []
  const say = (text: string): void => {
    out.push(encoder.encode(text))
  }

  if (/^\S+\s+CAPABILITY/i.test(line)) {
    say('* CAPABILITY IMAP4rev1 IDLE\r\n')
    say(`${tag} OK CAPABILITY completed\r\n`)
    return out
  }

  if (/^\S+\s+LOGIN/i.test(line)) {
    /*
     * ⚠ 真的校验凭据。
     *
     * 「什么都接受的 mock」会让「密码错应该不重试」这类测试**永远通过** ——
     * 而那正是最需要被验的一条（密码错时快速重连会把账号锁掉）。
     * mock 宽松到能掩盖被测行为时，它就只是在给测试发合格证。
     */
    const passMatch = /"((?:[^"\\]|\\.)*)"\s*$/.exec(line)
    const pass = passMatch ? passMatch[1].replace(/\\(.)/g, '$1') : ''
    if (!line.includes(VALID_CREDENTIALS.user) || pass !== VALID_CREDENTIALS.pass) {
      say(`${tag} NO [AUTHENTICATIONFAILED] Authentication failed\r\n`)
      return out
    }
    say(`${tag} OK LOGIN completed\r\n`)
    return out
  }

  if (/^\S+\s+SELECT\s+INBOX/i.test(line)) {
    state.selected = true
    say(`* ${state.exists} EXISTS\r\n`)
    say('* 0 RECENT\r\n')
    say(`* OK [UIDVALIDITY ${MAILBOX.uidValidity}] UIDs valid\r\n`)
    say(`* OK [UIDNEXT ${MAILBOX.uidNext}] Predicted next UID\r\n`)
    say('* FLAGS (\\Answered \\Flagged \\Deleted \\Draft \\Seen)\r\n')
    say(`${tag} OK [READ-WRITE] SELECT completed\r\n`)
    return out
  }

  /*
   * IDLE —— 这里**不回** `OK`，而是回 `+ idling` 然后挂住。
   *
   * 这是 IDLE 与其它命令最大的区别：它的「完成」信号是 `DONE`，不是带标记的 OK。
   * 测试服务器如果在这里回 OK，就测不出「客户端是否在等 DONE 的响应」——
   * 而那正是最容易写错的地方（提前发下一条命令会被服务器当成 IDLE 期间的
   * 非法输入）。
   */
  if (/^\S+\s+IDLE\s*$/i.test(line)) {
    if (!state.selected) {
      say(`${tag} BAD IDLE not allowed before SELECT\r\n`)
      return out
    }
    state.idling = true
    say('+ idling\r\n')
    return out
  }

  if (/^\S+\s+DONE\s*$/i.test(line)) {
    state.idling = false
    say(`${tag} OK IDLE completed\r\n`)
    return out
  }

  const searchMatch = /^\S+\s+UID\s+SEARCH\s+UID\s+(\d+):\*$/i.exec(line)
  if (searchMatch) {
    const from = Number.parseInt(searchMatch[1], 10)
    const uids = [...MAILBOX.messages.keys()].filter(uid => uid >= from).sort((a, b) => a - b)
    // `* SEARCH` 后面什么都没有也是合法响应（空结果）
    say(uids.length ? `* SEARCH ${uids.join(' ')}\r\n` : '* SEARCH\r\n')
    say(`${tag} OK SEARCH completed\r\n`)
    return out
  }

  const fetchMatch = /^\S+\s+UID\s+FETCH\s+(\d+):(\d+)\s+\(/i.exec(line)
  if (fetchMatch) {
    const from = Number.parseInt(fetchMatch[1], 10)
    const to = Number.parseInt(fetchMatch[2], 10)
    let seq = 1

    for (const [uid, { subject, body }] of [...MAILBOX.messages.entries()].sort((a, b) => a[0] - b[0])) {
      if (uid < from || uid > to)
        continue
      const raw = rawMessage(uid, subject, body)
      // 关键：字面量长度是**字节数**，后面紧跟恰好那么多字节
      const bytes = Buffer.byteLength(raw, 'utf8')
      say(`* ${seq} FETCH (UID ${uid} FLAGS (\\Seen) BODY[] {${bytes}}\r\n`)
      say(raw)
      say(')\r\n')
      seq++
    }
    say(`${tag} OK FETCH completed\r\n`)
    return out
  }

  if (/^\S+\s+LOGOUT/i.test(line)) {
    say('* BYE logging out\r\n')
    say(`${tag} OK LOGOUT completed\r\n`)
    state.closed = true
    return out
  }

  onUnexpected(line)
  say(`${tag} BAD unknown command\r\n`)
  return out
}

export interface MockImapServerOptions {
  /** 收到未实现的命令时回调（默认打到 stderr） */
  onUnexpected?: (line: string) => void
  /** 是否打印每条命令（调试用） */
  verbose?: boolean
}

export function startMockImapServer(port: number, options: MockImapServerOptions = {}): Promise<import('node:net').Server> {
  const onUnexpected = options.onUnexpected ?? ((line: string) => {
    process.stderr.write(`[mock-imap] 未实现的命令: ${line}\n`)
  })

  const server = createServer((socket) => {
    const state: ConnectionState = {
      closed: false,
      idling: false,
      selected: false,
      exists: MAILBOX.messages.size,
    }

    socket.write('* OK Mock IMAP ready\r\n')

    const session = {
      state,
      emit: (line: string) => {
        socket.write(line)
      },
    }
    idleSessions.add(session)
    socket.on('close', () => idleSessions.delete(session))

    let buffer = ''

    /*
     * ⚠ 显式 `setEncoding('utf8')`，而不是在 `data` 回调里 `TextDecoder().decode(chunk)`。
     *
     *   两个理由：
     *   1. **类型**：`data` 事件的参数在 Node 的类型里是 `Buffer | string`（取决于
     *      是否设过编码），直接 decode 过不了类型检查。
     *   2. **正确性**：IMAP 是**按行**的文本协议，而 TCP 会把一条命令切在任意字节上。
     *      设了编码之后 Node 自己负责跨 chunk 的 UTF-8 边界，下面的按 `\r\n` 切分
     *      才不会在多字节字符中间断掉 —— 手写 `TextDecoder.decode(chunk)` 在
     *      分片正好切在一个中文字符中间时会产生乱码，而 mock 数据里恰好有中文。
     */
    socket.setEncoding('utf8')

    socket.on('data', (chunk: string) => {
      buffer += chunk

      for (;;) {
        const index = buffer.indexOf('\r\n')
        if (index === -1)
          break
        const line = buffer.slice(0, index)
        buffer = buffer.slice(index + 2)
        if (!line)
          continue

        if (options.verbose)
          process.stdout.write(`[mock-imap] C: ${line}\n`)

        for (const reply of handle(line, state, onUnexpected))
          socket.write(reply)

        if (state.closed) {
          socket.end()
          return
        }
      }
    })

    socket.on('error', () => {
      // 客户端提前断开是正常情况（比如它自己超时了），不当作测试失败
    })
  })

  return new Promise((resolve) => {
    server.listen(port, '127.0.0.1', () => resolve(server))
  })
}
