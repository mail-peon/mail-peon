import type { WebSocket } from 'ws'
import type { ClientFrame, RelayTarget } from './protocol'
import { Buffer } from 'node:buffer'
import { HIGH_WATER_BYTES, IDLE_TIMEOUT_MS } from './config'
import { log, trace } from './logger'
import { connectUpstream, describeUpstreamError } from './upstream'

/**
 * 普通中继：把 WebSocket 的字节透传进 TCP。
 *
 * ⚠ **立刻建连接**，不等第一条消息 —— 有些用法一个字节都不发，只是等中继去连
 *   （见 `onConnection` 的说明 ①）。
 *
 * @param ws 客户端连接
 * @param target 已经过策略检查的目标
 * @param onConnectError 连接建立失败时回调（`null` = 成功）
 * @returns 转发一帧的函数；传 `null` 表示「这条连接改用别的模式了，请关掉」。
 *   WebSocket 已经不在 OPEN 状态时返回 `null`（调用方应当直接放弃）。
 */
export function startPassthrough(
  ws: WebSocket,
  target: RelayTarget,
  onConnectError: (error: Error | null) => void,
): ((frame: ClientFrame | null) => void) | null {
  if (ws.readyState !== ws.OPEN)
    return null

  log(`CONNECT ${target.host}:${target.port}${target.tls ? ' (tls)' : ''}`)
  /*
   * ⚠ 这里是整个中继最关键的一行。
   *
   * 993 端口是 **implicit TLS**：连上立刻握手，握手完成前不接受任何 IMAP 命令。
   * 用裸 `net.connect()` 连上去、把明文的 `A0001 LOGIN ...` 发过去，服务器会看到
   * 一堆不是 ClientHello 的字节 —— 直接关连接，而且日志里看不出原因。
   *
   * `servername` 就是 SNI：共享 IP 的邮件服务器靠它选择证书，
   * 不给的话很多服务器直接拒握手（或回一张不匹配的证书）。
   */
  const socket = connectUpstream({ host: target.host, port: target.port, tls: target.tls })

  socket.setTimeout(IDLE_TIMEOUT_MS)

  /** 记录「谁先关的」，避免两边互相触发 close 造成重复日志 */
  let closed = false
  /** @param reason 关闭原因（只进日志） */
  const shutdown = (reason: string): void => {
    if (closed)
      return
    closed = true
    log(`CLOSE  ${target.host}:${target.port}（${reason}）`)
    try {
      socket.destroy()
    }
    catch {}
    try {
      ws.close()
    }
    catch {}
  }

  // --- TCP → WebSocket（带背压）------------------------------------------------
  let inFlightBytes = 0
  let tcpPaused = false

  /**
   * 积压降到阈值一半时恢复，避免在阈值附近反复暂停/恢复（抖动）。
   * 抖动本身不算 bug，但每次都会打一行日志，会把真正有用的信息淹掉。
   */
  const RESUME_WATER_BYTES = HIGH_WATER_BYTES / 2

  socket.on('data', (chunk) => {
    if (closed || ws.readyState !== ws.OPEN)
      return

    /*
     * ⚠ `chunk` 在 Node 的类型里是 `Buffer`，但 `net.Socket` 的 data 事件实际给的是
     *   `Buffer`。这里显式转一次 `Buffer.from` 是为了拿到确定的字节长度语义：
     *   一个 `Uint8Array` 可能是更大 buffer 上的视图，而 `chunk.length` 与
     *   `Buffer.byteLength(chunk)` 在那种情况下含义不同。
     */
    const bytes = Buffer.from(chunk)
    trace('←', bytes)
    inFlightBytes += bytes.length

    // 回调在数据真正写出去之后触发 —— 用它把在途字节数减回去
    ws.send(bytes, () => {
      inFlightBytes = Math.max(0, inFlightBytes - bytes.length)
      if (tcpPaused && inFlightBytes <= RESUME_WATER_BYTES) {
        tcpPaused = false
        socket.resume()
      }
    })

    if (!tcpPaused && inFlightBytes >= HIGH_WATER_BYTES) {
      tcpPaused = true
      socket.pause()
      log(`背压：在途 ${inFlightBytes} 字节，暂停读取（${target.host}）`)
    }
  })

  // --- WebSocket → TCP（带背压）------------------------------------------------
  let wsPaused = false

  /**
   * 转发一帧：写进 TCP。传 `null` 表示「改用别的模式了，把这条连接关掉」。
   *
   * @param frame 客户端的一帧；`null` = 改用 watch 模式
   */
  const forward = (frame: ClientFrame | null): void => {
    if (frame === null) {
      shutdown('改用 watch 模式')
      return
    }
    if (closed || socket.destroyed)
      return

    const { data, isBinary } = frame

    /*
     * 二进制帧直接透传；文本帧按 utf8 编码后透传（IMAP 本身是字节协议）。
     * 扩展侧用 `binaryType = 'arraybuffer'` 且只发二进制帧，文本分支是兜底。
     *
     * ⚠ `data as ArrayBuffer` 只是把 `RawData`（`Buffer | ArrayBuffer | Buffer[]`）
     *   缩到「扩展侧实际会发的那一种」；运行时 `Buffer.from` 仍然按**实参的真实类型**
     *   分派（`Buffer.from(Buffer)` 同样是复制字节），所以行为与改动前完全一致。
     */
    const payload = isBinary
      ? Buffer.from(data as ArrayBuffer)
      : Buffer.from(String(data), 'utf8')

    trace('→', payload)

    const ok = socket.write(payload)

    /*
   * `write()` 返回 false = 内核 / Node 内部缓冲已满。这时必须暂停 WebSocket 的
   * 接收，否则客户端继续快发会把内存堆起来。
   *
   * ⚠ 不能在 `drain` 之前恢复：`drain` 之后 `write()` 才可能重新返回 true。
   *   这里的 `ws.pause()` / `ws.resume()` 是 ws 库提供的流控（底层是 TCP 的
   *   接收窗口），不是「丢弃消息」—— 消息留在内核缓冲区里。
   */
    if (!ok && !wsPaused) {
      wsPaused = true
      ws.pause()
    }
  }

  /// 分流之后由 `onConnection` 调用的转发入口（它拿到的是 `{data, isBinary}`）
  /** @param frame 客户端的一帧；`null` = 改用 watch 模式 */
  const forwardFrame = (frame: ClientFrame | null): void => forward(frame)

  /**
   * 注册「从第二帧起」的转发。
   *
   * ⚠ 由 `onConnection` 在分流完成**之后**调用，不能在这里立刻注册。
   *
   *   第一帧由 `onConnection` 的 `once('message')` 读走用于分流，再由它调
   *   `forwardFrame` 补投。如果这个 `ws.on('message')` 从一开始就挂着，
   *   第一帧会被处理**两次** —— 实测症状是「回声测试收到 84 字节，期望 42」。
   */
  const startForwarding = (): void => {
    ws.on('message', (data, isBinary) => {
      forward({ data, isBinary })
    })
  }

  socket.on('connect', () => {
    // 纯 TCP：连上就算成功
    if (!target.tls)
      onConnectError(null)
  })

  socket.on('drain', () => {
    if (wsPaused && !closed) {
      wsPaused = false
      ws.resume()
    }
  })

  // --- 错误 / 关闭 --------------------------------------------------------------
  socket.on('error', (error) => {
    // 两条连接路径共用错误码和证书提示；无 code 时保留原始 message。
    const detail = describeUpstreamError(error)

    /*
     * 只有在**连接还没建立**时才算「建连失败」。
     *
     * 判断依据是 `socket.connecting`（Node 的标准属性）：连接建立之后的错误
     * （比如服务器中途 RST）不该再报给分流逻辑 —— 那时已经没有「要不要分流」
     * 这回事了。
     */
    if (socket.connecting)
      onConnectError(new Error(`${detail}`))

    shutdown(`tcp error: ${detail}`)
  })

  socket.on('timeout', () => {
    shutdown('idle timeout')
  })

  socket.on('close', () => {
    shutdown('tcp closed')
  })

  ws.on('close', () => {
    shutdown('ws closed')
  })

  ws.on('error', (error) => {
    shutdown(`ws error: ${error.message}`)
  })

  /**
   * 分流完成后由 `onConnection` 调用的入口：先挂上后续帧的转发，再补投第一帧。
   *
   * @param frame 被分流扣下的第一帧；`null` = 改用 watch 模式
   */
  const accept = (frame: ClientFrame | null): void => {
    // 分流完成，从这一刻起后续帧都按透传处理
    startForwarding()
    forwardFrame(frame)
  }

  return accept
}
