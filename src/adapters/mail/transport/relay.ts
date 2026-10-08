import type { MailSocket, MailSocketFactory, MailSocketTarget } from './types'
import { MailTransportError, MailTransportUnavailableError } from './types'

/**
 * WebSocket ↔ TCP 中继传输。
 *
 * 中继的契约（**只管字节，不懂 IMAP**）：
 *
 *   - 客户端连 `wss://<relay>/<host>:<port>`（或 `?host=&port=` 查询参数）；
 *   - 中继与 `<host>:<port>` 建 TCP 连接，之后**双向原样转发字节**；
 *   - `tls=1`（或路径里带 `tls`）时中继负责 TLS 握手；
 *   - 任一方向关闭即关闭另一方向。
 *
 * ⚠ 中继**看不到明文**（TLS 在扩展与邮件服务器之间端到端），也**不解析 IMAP**，
 *   所以它拿不到邮件正文，也拿不到「用户读了哪封」。这是设计文档「不做服务端中转」
 *   那条原则能被放宽到「允许自建隧道」的前提 —— 隧道不是服务，它是根网线。
 *
 * 没配中继时抛 `MailTransportUnavailableError`：UI 要把它和「密码错了」区分开，
 * 前者是「这条路在当前环境走不通」，后者是「你填错了」。
 */

/** 把 `wss://relay.example.com/` + `imap.gmail.com:993` 拼成中继 URL */
export function buildRelayUrl(relayUrl: string, target: MailSocketTarget): string {
  const url = new URL(relayUrl)
  const hostPort = `${target.host}:${target.port}`

  // 中继已给出路径（`wss://relay/tunnel`）时，把 host:port 挂成查询参数，
  // 不覆盖用户写的路径 —— 自建中继常见做法是把隧道放在某个子路径下。
  if (url.pathname && url.pathname !== '/') {
    url.searchParams.set('host', target.host)
    url.searchParams.set('port', String(target.port))
  }
  else {
    url.pathname = `/${hostPort}`
  }

  url.searchParams.set('tls', target.tls ? '1' : '0')
  return url.toString()
}

/**
 * 建一条经中继的连接。
 *
 * 用 `binaryType = 'arraybuffer'`：IMAP 的响应可以是任意字节（附件、非 UTF-8 头），
 * 默认的 `'blob'` 要先 `await blob.arrayBuffer()`，多一次拷贝且读回调得写成 async。
 */
export const relaySocketFactory: MailSocketFactory = async (target) => {
  if (!target.relayUrl) {
    throw new MailTransportUnavailableError(
      '当前环境没有裸 TCP，IMAP 需要配置一个 WebSocket↔TCP 中继地址（wss://…）。'
      + '要么在账号里填中继，要么改用 Gmail（OAuth）协议。',
    )
  }

  if (typeof WebSocket === 'undefined') {
    throw new MailTransportUnavailableError('当前环境不支持 WebSocket，无法建立 IMAP 连接')
  }

  const url = buildRelayUrl(target.relayUrl, target)
  const ws = new WebSocket(url)
  ws.binaryType = 'arraybuffer'

  const queue = new ByteQueue()
  let closed = false

  const socket: MailSocket = {
    get closed() {
      return closed
    },
    read: () => queue.read(),
    write(data) {
      if (closed)
        return
      try {
        // ⚠ 必须把 Uint8Array 的**精确视图**发出去：Node 的 Buffer 与某些实现会
        //   带着更大的底层 ArrayBuffer，直接发会把别人的字节一起送过去。
        ws.send(data.slice().buffer)
      }
      catch (error) {
        queue.fail(new MailTransportError('中继写入失败', { cause: error }))
      }
    },
    close() {
      if (closed)
        return
      closed = true
      queue.end()
      try {
        ws.close()
      }
      catch {
        // 已经关了
      }
    },
  }

  ws.onmessage = (event) => {
    if (closed)
      return
    if (event.data instanceof ArrayBuffer)
      queue.push(new Uint8Array(event.data))
    else if (typeof event.data === 'string')
      queue.push(new TextEncoder().encode(event.data))
  }
  ws.onerror = () => {
    queue.fail(new MailTransportError(`无法连接中继：${url}`))
  }
  ws.onclose = () => {
    if (closed)
      return
    closed = true
    queue.end()
  }

  await waitForOpen(ws, url)
  return socket
}

function waitForOpen(ws: WebSocket, url: string): Promise<void> {
  if (ws.readyState === WebSocket.OPEN)
    return Promise.resolve()

  return new Promise<void>((resolve, reject) => {
    const onOpen = () => {
      cleanup()
      resolve()
    }
    const onError = () => {
      cleanup()
      reject(new MailTransportError(`无法连接中继：${url}`))
    }
    const onClose = () => {
      cleanup()
      reject(new MailTransportError(`中继在握手阶段就关闭了连接：${url}`))
    }
    function cleanup(): void {
      ws.removeEventListener('open', onOpen)
      ws.removeEventListener('error', onError)
      ws.removeEventListener('close', onClose)
    }

    ws.addEventListener('open', onOpen)
    ws.addEventListener('error', onError)
    ws.addEventListener('close', onClose)
  })
}

/**
 * 字节队列：把「到达即推」的 WebSocket 回调转成「按需拉」的 `read()`。
 *
 * 存在的意义是 IMAP 解析器要能**按需读**（读一行、再读 N 字节），而 WebSocket 是
 * 推模型。没有这层的话协议层得自己维护缓冲区与等待者列表 —— 那份代码跟 IMAP
 * 一点关系都没有。
 *
 * ⚠ `push` / `end` / `fail` 的语义必须分清楚：
 *   - `end()`：正常关闭，**排空已有数据后**再给 `null`（最后一个响应可能和 FIN 同时到）；
 *   - `fail()`：异常，直接抛给读者，**并且丢弃已排队的数据**（半截响应解析出来的
 *     东西一定是错的，交给上层重连比让它猜更安全）。
 */
class ByteQueue {
  private chunks: Uint8Array[] = []
  private waiter: { resolve: (value: Uint8Array | null) => void, reject: (error: unknown) => void } | null = null
  private ended = false
  private error: unknown = null

  push(chunk: Uint8Array): void {
    if (this.error || this.ended)
      return
    if (this.waiter) {
      // 去掉空分片：`read()` 的契约是「非空或 null」，返回空数组会让解析器空转
      if (chunk.length > 0) {
        const { resolve } = this.waiter
        this.waiter = null
        resolve(chunk)
      }
      return
    }
    this.chunks.push(chunk)
  }

  read(): Promise<Uint8Array | null> {
    if (this.error)
      return Promise.reject(this.error)
    const head = this.chunks.shift()
    if (head)
      return Promise.resolve(head)
    if (this.ended)
      return Promise.resolve(null)
    return new Promise<Uint8Array | null>((resolve, reject) => {
      this.waiter = { resolve, reject }
    })
  }

  end(): void {
    this.ended = true
    if (this.waiter && this.chunks.length === 0) {
      const { resolve } = this.waiter
      this.waiter = null
      resolve(null)
    }
  }

  fail(error: unknown): void {
    this.error = error
    this.chunks = []
    if (this.waiter) {
      const { reject } = this.waiter
      this.waiter = null
      reject(error)
    }
  }
}
