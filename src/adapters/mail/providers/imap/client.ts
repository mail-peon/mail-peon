import type { MailSocket } from '../../transport/types'
import { MailTransportError } from '../../transport/types'

/**
 * 极简 IMAP4rev1 客户端。
 *
 * 只实现 mail-peon 真正需要的五件事，刻意**不**做成一门通用 IMAP 库：
 *
 *   1. `LOGIN`（明文密码，**必须先 TLS**）
 *   2. `SELECT INBOX` → 取 `UIDNEXT` / `UIDVALIDITY` / `EXISTS`
 *   3. `UID FETCH <from>:* (UID FLAGS BODY.PEEK[])` → 增量拿原始邮件
 *   4. `UID SEARCH UID <from>:*` → 只要 UID 列表（快路径 / 将来分批用）
 *   5. `LOGOUT`
 *
 * 为什么不用 `imapflow` / `emailjs-imap-client`：
 *   - `imapflow` import 的是 Node 的 `net` / `tls` / `stream`，MV3 Service Worker
 *     里直接炸；
 *   - `emailjs-imap-client` 更老，同样绑死 Node 的 `net`。
 *   这套代码的**唯一**环境依赖是 `MailSocket`（见 `transport/types.ts`），
 *   所以它能跑在 SW、跑在单测里，也能跑在将来任何有字节流的地方。
 *
 * ⚠ 解析上的两个坑，都能在真机上表现成「偶发丢邮件 / 正文截断」：
 *
 *   1. **字面量（literal）**：`FETCH` 响应里正文以 `{12345}` 的形式给出长度，
 *      紧跟 CRLF，然后是**恰好那么多字节**的任意二进制。按行读会把它切碎、也会
 *      把二进制内容当语法解析。所以检测到行尾 `{N}` 时必须转成「精确读 N 字节」。
 *      `{N+}` 是非同步字面量（LITERAL+），对本客户端来说解析完全一样。
 *   2. **不做括号配对**：`BODY[HEADER.FIELDS (SUBJECT)]` 这类响应里有嵌套括号，
 *      按「第一个 `(` 到最后一个 `)`」扫会错。本实现只做**行内正则 + 字节扫描**，
 *      不构建语法树 —— 需要的信息（UID / FLAGS / 字面量长度）都能直接扫出来。
 *
 * ⚠ 还有一个 IMAP 语义坑值得单独记下来：`UID FETCH 100:*` 在 100 超出末尾时，
 *   服务器会返回**序列里最大的那个 UID**（RFC 3501 的 `*` 语义）。所以「没有新邮件」
 *   时反而会收到一封**旧**邮件。调用方必须按 `sinceUid` 显式过滤，否则症状是
 *   「每次心跳都把最后一封邮件重新入库一遍」。
 */

/** 一次 `UID FETCH` 拿回来的条目 */
export interface ImapFetchedMessage {
  uid: number
  /** 原始 RFC822 字节流（`BODY.PEEK[]`，不会置 \Seen） */
  source: Uint8Array
  flags: string[]
}

export interface ImapMailboxStatus {
  /** 下一封新邮件将获得的 UID（= 已有最大 UID + 1） */
  uidNext: number
  /** 邮箱代次；变化即意味着历史 UID 全部失效 */
  uidValidity: number
  /** 邮件总数 */
  exists: number
}

export interface ImapClientOptions {
  /** 单条命令的超时（毫秒）。IMAP 服务器偶尔不响应，没有超时就是永久挂起 */
  commandTimeoutMs?: number
}

/** 默认 30s：正常服务器毫秒级返回，超过这个量级基本是端点挂了 */
const DEFAULT_COMMAND_TIMEOUT_MS = 30_000

export class ImapProtocolError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ImapProtocolError'
  }
}

interface PendingState {
  messages: Map<number, ImapFetchedMessage>
  status: Partial<ImapMailboxStatus>
  /**
   * 刚读到「以 `{N}` 结尾」的那一行，正等它的 N 字节。
   *
   * 必须把**那一行原文**也存着：UID 与 FLAGS 都在行里，而正文要等字节读出来
   * 才能和它对上号。先读字节再解析行的话，就得为「UID 还没解析出来」单独开一条
   * 状态通路 —— 存原文最省事，也最不容易错。
   */
  expecting: { line: string, remaining: number } | null
}

export class ImapClient {
  /**
   * 接收缓冲区。
   *
   * ⚠ 显式标成 `Uint8Array<ArrayBufferLike>`：TS 5.7+ 的 `Uint8Array` 带了
   *   buffer 类型参数，`subarray()` 返回的是 `ArrayBufferLike` 而 `slice()` 返回
   *   `ArrayBuffer`，两者混用时默认泛型会打架（症状是一堆莫名其妙的赋值错误）。
   *   这里统一放宽到 `ArrayBufferLike`，两边都能放进来。
   */
  private buffer: Uint8Array<ArrayBufferLike> = new Uint8Array(0)
  private tagSeq = 0
  private inboxSelected = false
  private loggedOut = false

  private readonly pending: PendingState = {
    messages: new Map(),
    status: {},
    expecting: null,
  }

  constructor(
    private readonly socket: MailSocket,
    private readonly options: ImapClientOptions = {},
  ) {}

  // -------------------------------------------------------------------------
  // 命令
  // -------------------------------------------------------------------------

  async login(user: string, pass: string): Promise<void> {
    // 引号与反斜杠要转义，否则密码里的 `"` 会把命令截断成一个语法错误，
    // 而报错信息完全看不出是密码的问题
    const response = await this.command(`LOGIN ${quote(user)} ${quote(pass)}`)
    if (!response.ok)
      throw new ImapProtocolError(`登录失败：${response.text || '服务器拒绝'}`)
  }

  async selectInbox(): Promise<ImapMailboxStatus> {
    this.pending.status = {}
    const response = await this.command('SELECT INBOX')
    if (!response.ok)
      throw new ImapProtocolError(`无法打开收件箱：${response.text || '服务器拒绝'}`)
    this.inboxSelected = true

    const status = this.pending.status
    return {
      uidNext: status.uidNext ?? 0,
      uidValidity: status.uidValidity ?? 0,
      exists: status.exists ?? 0,
    }
  }

  /**
   * 拉一个**明确**的 UID 区间。
   *
   * ⚠ 这里**没有**「拉 `UID > x` 的全部」那种方法（`fetchSince(a, { limit })`），
   *   而且它是被**故意删掉**的 —— 保留一个「能用但在真实邮箱上必然出错」的 API
   *   比没有它更糟。它踩过的坑（见 `imap-provider` 的 `fetchSince` 注释）：
   *
   *   1. 服务器会把整个区间的正文都发过来，`limit` 只是客户端**收完之后**的截断。
   *      用户邮箱有 3 万多封、游标之后积压几千封时，就是几千次 `BODY.PEEK[]`
   *      全量传输 —— 30 秒命令超时必然被撞爆（真机症状：UI 报「请求超时」，
   *      而中继日志里 `CONNECT` 之后再无输出）。
   *   2. 调用方很容易顺手写成「先全拉、再 `slice(-N)` 取最新的」，然后推进游标 ——
   *      中间那些邮件就**永久丢失**了，而界面上看不出任何异常。
   *
   * 正确的入口是 `searchSince`（先拿 UID 列表）+ `fetchRange`（只取需要的一段）。
   *
   * 少数服务器不支持 `a:*` 的部分区间变体，但**都**支持确定区间 `a:b`。
   */
  async fetchRange(fromUid: number, toUid: number): Promise<ImapFetchedMessage[]> {
    this.ensureSelected()
    if (toUid < fromUid)
      return []

    this.pending.messages = new Map()
    this.pending.expecting = null

    const response = await this.command(`UID FETCH ${fromUid}:${toUid} (UID FLAGS BODY.PEEK[])`)
    if (!response.ok)
      throw new ImapProtocolError(`拉取邮件失败：${response.text || '服务器拒绝'}`)

    return [...this.pending.messages.values()]
      .filter(message => message.uid >= fromUid && message.uid <= toUid)
      .sort((a, b) => a.uid - b.uid)
  }

  /**
   * 只要 UID 列表（不拉正文）。
   *
   * 这是处理积压的**第一步**：先拿到「有哪些 UID」，再用 `fetchRange` 只取需要的那一批。
   * 一个整数几十字节，几千个 UID 也就几十 KB —— 和几千封完整邮件的正文相比可以忽略。
   */
  async searchSince(sinceUid: number): Promise<number[]> {
    this.ensureSelected()
    const response = await this.command(`UID SEARCH UID ${sinceUid + 1}:*`)
    if (!response.ok)
      throw new ImapProtocolError(`搜索失败：${response.text || '服务器拒绝'}`)

    // `* SEARCH 1 2 3`；`* SEARCH`（空结果）也是合法响应
    const match = /^\* SEARCH\b([\s\S]*)$/m.exec(response.text)
    if (!match)
      return []
    return match[1]
      .trim()
      .split(/\s+/)
      .map(token => Number.parseInt(token, 10))
      .filter(uid => Number.isFinite(uid) && uid > sinceUid)
      .sort((a, b) => a - b)
  }

  async logout(): Promise<void> {
    if (this.loggedOut)
      return
    this.loggedOut = true
    try {
      await this.command('LOGOUT', { tolerateClosed: true })
    }
    catch {
      // LOGOUT 时服务器常常直接关连接，收不到 OK 是正常的
    }
    finally {
      this.socket.close()
    }
  }

  /** 不管协议状态，直接断开（错误路径上用） */
  dispose(): void {
    this.loggedOut = true
    this.socket.close()
  }

  private ensureSelected(): void {
    if (!this.inboxSelected)
      throw new ImapProtocolError('必须先 SELECT INBOX 才能拉邮件')
  }

  // -------------------------------------------------------------------------
  // 命令发送 / 响应读取
  // -------------------------------------------------------------------------

  private async command(
    text: string,
    options: { tolerateClosed?: boolean } = {},
  ): Promise<{ ok: boolean, text: string }> {
    const tag = `A${String(++this.tagSeq).padStart(4, '0')}`
    this.socket.write(encode(`${tag} ${text}\r\n`))

    const collected: string[] = []
    const deadline = Date.now() + (this.options.commandTimeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS)

    for (;;) {
      const line = await this.readLine(deadline)
      if (line === null) {
        // 连接关掉了：LOGIN 阶段发生就是「鉴权失败后服务器直接断线」
        if (options.tolerateClosed)
          return { ok: true, text: collected.join('\n') }
        throw new MailTransportError('IMAP 连接在等待响应时被关闭（可能是 TLS / 中继问题）')
      }

      // 带标记的响应 = 命令结束。**先判它**：`{N}` 只会出现在未标记响应里，
      // 但顺序判反会让一行错误信息被当成字面量长度。
      if (line.startsWith(`${tag} `)) {
        const rest = line.slice(tag.length + 1)
        collected.push(rest)
        return { ok: /^OK\b/i.test(rest), text: collected.join('\n') }
      }

      // `+ ` 是 continuation（AUTHENTICATE / APPEND 用），本客户端发的命令都不需要
      if (line.startsWith('+ '))
        throw new ImapProtocolError(`服务器要求继续发送数据，但本客户端不支持：${line.slice(2)}`)

      // 字面量：这一行以 `{N}` 结尾时，后面紧跟恰好 N 字节的原始数据
      const literalLength = readLiteralLength(line)
      if (literalLength !== null) {
        this.pending.expecting = { line, remaining: literalLength }
        const payload = await this.readBytes(literalLength, deadline)
        this.pending.expecting = null
        this.handleUntagged(line, payload)
        collected.push(line)
        continue
      }

      collected.push(line)
      if (line.startsWith('* '))
        this.handleUntagged(line, null)
    }
  }

  /** 读一行（不含 CRLF）；连接关闭返回 `null` */
  private async readLine(deadline: number): Promise<string | null> {
    for (;;) {
      const index = indexOfCrlf(this.buffer)
      if (index !== -1) {
        const line = decode(this.buffer.subarray(0, index))
        this.buffer = this.buffer.subarray(index + 2)
        return line
      }
      const chunk = await this.readChunk(deadline)
      if (chunk === null)
        return null
    }
  }

  /**
   * 精确读 N 字节。
   *
   * 连接在读到一半时断掉是**协议错误而不是正常关闭** —— 半截 RFC822 解析出来的
   * 邮件一定是错的，宁可整轮同步失败让下次重试（游标没推进，不会丢件）。
   */
  private async readBytes(length: number, deadline: number): Promise<Uint8Array> {
    while (this.buffer.length < length) {
      const chunk = await this.readChunk(deadline)
      if (chunk === null)
        throw new MailTransportError('IMAP 连接在读取正文时被关闭')
    }
    // 拷一份出去：缓冲区要往后挪，不能把视图交给调用方（它下次读就会变）
    const out = new Uint8Array(this.buffer.subarray(0, length))
    this.buffer = this.buffer.subarray(length)
    return out
  }

  private async readChunk(deadline: number): Promise<Uint8Array | null> {
    const remaining = deadline - Date.now()
    if (remaining <= 0)
      throw new MailTransportError('IMAP 服务器响应超时')

    let chunk: Uint8Array | null
    try {
      chunk = await withTimeout(this.socket.read(), remaining)
    }
    catch (error) {
      if (error instanceof MailTransportError)
        throw error
      throw new MailTransportError(
        `读取 IMAP 响应失败：${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      )
    }

    if (chunk !== null && chunk.length > 0)
      this.buffer = concat(this.buffer, chunk)
    return chunk
  }

  // -------------------------------------------------------------------------
  // 未标记响应解析
  // -------------------------------------------------------------------------

  private handleUntagged(line: string, literal: Uint8Array | null): void {
    // `* 123 FETCH (UID 456 FLAGS (\Seen) BODY[] {789}`（或已带出字面量的形态）
    if (/^\*\s+\d+\s+FETCH\s+\(/i.test(line)) {
      const uid = readUidFromFetch(line)
      if (uid === null)
        return

      const existing = this.pending.messages.get(uid)
      const entry: ImapFetchedMessage = existing ?? { uid, source: new Uint8Array(0), flags: [] }
      entry.flags = readFlagsFromFetch(line)
      // 同一封邮件可能分多个 FETCH 响应回来（header 一个、body 一个），
      // 只保留真正带正文的那一次，别让后面的空壳覆盖掉前面的正文
      if (literal && literal.length > 0)
        entry.source = literal

      this.pending.messages.set(uid, entry)
      return
    }

    const exists = /^\*\s+(\d+)\s+EXISTS\b/i.exec(line)
    if (exists) {
      this.pending.status.exists = Number.parseInt(exists[1], 10)
      return
    }

    // `* OK [UIDNEXT 4392] Predicted next UID`
    const uidNext = /\[\s*UIDNEXT\s+(\d+)\s*\]/i.exec(line)
    if (uidNext) {
      this.pending.status.uidNext = Number.parseInt(uidNext[1], 10)
      return
    }

    const uidValidity = /\[\s*UIDVALIDITY\s+(\d+)\s*\]/i.exec(line)
    if (uidValidity)
      this.pending.status.uidValidity = Number.parseInt(uidValidity[1], 10)
  }
}

// ---------------------------------------------------------------------------
// 行内扫描（不做语法树）
// ---------------------------------------------------------------------------

/**
 * 这一行末尾是 `{N}` / `{N+}` 吗？是则返回 N。
 *
 * `{N+}` 是 LITERAL+ 扩展的「非同步字面量」：客户端不需要先发 continuation，
 * 服务器直接把数据送出来。对本客户端（只读、从不在命令里带字面量）来说，
 * 两者的解析完全一样。
 */
export function readLiteralLength(line: string): number | null {
  const match = /\{(\d+)\+?\}$/.exec(line)
  if (!match)
    return null
  const length = Number.parseInt(match[1], 10)
  return Number.isFinite(length) ? length : null
}

/** 从 `* n FETCH (… UID 123 …)` 里取 UID */
function readUidFromFetch(line: string): number | null {
  const match = /\bUID\s+(\d+)\b/i.exec(line)
  if (!match)
    return null
  const uid = Number.parseInt(match[1], 10)
  return Number.isFinite(uid) ? uid : null
}

/** 从 `* n FETCH (… FLAGS (\Seen \Answered) …)` 里取 flags（去掉 `\` 前缀） */
function readFlagsFromFetch(line: string): string[] {
  const match = /\bFLAGS\s+\(([^)]*)\)/i.exec(line)
  if (!match)
    return []
  return match[1]
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map(flag => flag.replace(/^\\/, ''))
}

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------

function indexOfCrlf(buffer: Uint8Array): number {
  for (let i = 0; i + 1 < buffer.length; i++) {
    if (buffer[i] === 0x0D && buffer[i + 1] === 0x0A)
      return i
  }
  return -1
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  if (a.length === 0)
    return b
  const out = new Uint8Array(a.length + b.length)
  out.set(a, 0)
  out.set(b, a.length)
  return out
}

const encoder = new TextEncoder()
const decoder = new TextDecoder('utf-8', { fatal: false })

function encode(text: string): Uint8Array {
  return encoder.encode(text)
}

function decode(bytes: Uint8Array): string {
  return decoder.decode(bytes)
}

/**
 * IMAP 带引号字符串的转义。
 *
 * ⚠ 只转义 `"` 与 `\`：随机密码里出现这两个字符很常见，不转义会把命令截断成
 *   一个语法错误，而报错信息完全看不出问题在密码上。
 */
export function quote(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
}

async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new MailTransportError('IMAP 服务器响应超时')), ms)
      }),
    ])
  }
  finally {
    if (timer)
      clearTimeout(timer)
  }
}
