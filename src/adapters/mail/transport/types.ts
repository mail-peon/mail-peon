/**
 * 传输层抽象：**整套 IMAP 代码里唯一碰「字节怎么出去」的地方**。
 *
 * 为什么需要它（这是本文件存在的全部理由）：
 *
 * MV3 扩展里**没有裸 TCP**。`chrome.sockets.tcp` 只属于已废弃的 Chrome Apps，
 * 扩展拿不到；`imapflow` 那类库 import 的是 Node 的 `net` / `tls`，在 Service Worker
 * 里直接炸。所以「IMAP + 用户名密码」在扩展里要走通，只有一条路：
 * **把字节经 WebSocket 转发到一个 TCP 中继**。
 *
 * 于是这里把「一条可靠字节流」抽成 `MailSocket`，两种实现挂在后面：
 *   - `relay.ts`  —— `wss://` ↔ TCP 中继（本文件主要服务的对象）
 *   - 将来若有 native messaging / 别的通道，加一个实现即可，**协议层一行不用改**
 *
 * 协议层（`client.ts`）只认 `MailSocket`，不知道底下是 WebSocket 还是别的什么。
 */

/** 一条已建立的、双向的、有背压的字节流 */
export interface MailSocket {
  /**
   * 收字节。
   *
   * 返回的 promise 在有数据时 resolve 一个**非空**分片；连接关闭时 resolve
   * `null`（**不 reject**）—— 关闭是正常终态，让调用方用一个 `if` 处理，
   * 否则每处 `read()` 都要包 try/catch，还得区分「关掉了」与「读失败了」。
   */
  read: () => Promise<Uint8Array | null>
  write: (data: Uint8Array) => void
  /** 主动关闭；重复调用必须安全 */
  close: () => void
  /** 连接已关闭（对端关闭或本地 close 之后为 true） */
  readonly closed: boolean
}

/** 建连参数 */
export interface MailSocketTarget {
  host: string
  port: number
  /** true = 建连后立即 TLS（IMAP 的 993 端口就是这样） */
  tls: boolean
  /** 中继地址（`wss://…`）；为空时实现方应抛「未配置中继」 */
  relayUrl?: string
}

/**
 * 建连函数。
 *
 * 抽成函数而**不是**接口 + 实现类：协议层只需要「给我一条流」，不需要知道
 * 谁提供的。测试里塞一个假的同构实现即可，不必起真连接。
 */
export type MailSocketFactory = (target: MailSocketTarget) => Promise<MailSocket>

/** 传输层不可用（当前环境没有路可走）—— 单独一个错误类型，UI 要区分它 */
export class MailTransportUnavailableError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'MailTransportUnavailableError'
  }
}

/** 建连 / 传输过程中出的错 */
export class MailTransportError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = 'MailTransportError'
  }
}
