import { Buffer } from 'node:buffer'

/**
 * 带**行边界保护**的字节缓冲区。
 *
 * ⚠ 这一层是必需的，不是过度设计：TLS 分片**会在任意字节位置切开一行**。
 *   `read()` 返回的可能是半行、也可能是三行半。直接把每段当整行解析，
 *   会在「`* 12 EXISTS` 被切成 `* 12 EX` + `ISTS`」时解析出垃圾 ——
 *   而症状是「偶尔漏掉一封邮件」，几乎无法复现。
 *
 * 与扩展侧 `ImapClient` 里那份是同一个设计；中继是独立进程、不能 import
 * 扩展的 TS 代码，所以这里必须有一份自己的。（这重复是刻意的：
 * 中继要保持「零依赖、可直接 node 跑」。）
 */
export class LineBuffer {
  /**
   * 还没被切出完整行的字节。
   *
   * ⚠ 类型是 `Buffer` 而不是 `Uint8Array`：`subarray()` 与 `indexOf('\r\n')`
   *   这两个用法都依赖 Buffer 的成员，而 `next()` 返回的是**视图**（不复制），
   *   所以这里必须一直持有可能比视图形状更宽的原始缓冲。
   */
  pending: Buffer

  constructor() {
    this.pending = Buffer.alloc(0)
  }

  /** @param chunk 刚收到的一段字节（可能在某一行中间被切开） */
  push(chunk: Buffer): void {
    this.pending = this.pending.length ? Buffer.concat([this.pending, chunk]) : chunk
  }

  /**
   * 取下一行（不含 CRLF）。
   *
   * @returns 没有完整行时返回 null
   */
  next(): string | null {
    const index = this.pending.indexOf('\r\n')
    if (index === -1)
      return null
    const line = this.pending.subarray(0, index).toString('utf8')
    this.pending = this.pending.subarray(index + 2)
    return line
  }

  /** 丢掉缓冲（重连时用 —— 上一个连接的半个响应不能带到新连接里） */
  reset(): void {
    this.pending = Buffer.alloc(0)
  }
}
