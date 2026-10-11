/**
 * 中继 watch 连接的**握手看门狗**。
 *
 * ## 它解决的是什么
 *
 * `scripts/imap-relay.ts` 的 `watchOnce()` 里有一句 `socket.setTimeout(0)`：
 * watch 连接挂上 `IDLE` 之后会长期静默（可能几十分钟没有任何字节），所以**不能**
 * 沿用普通连接那个 15 分钟空闲超时 —— 那会把一条健康的连接当成超时踢掉。
 *
 * 但这样一来**握手阶段也没有任何时间上限了**（这段静默与 IDLE 的静默在 socket
 * 层面长得一模一样，没法用同一个超时值区分）。后果是一个真机上极难排查的故障：
 *
 *   TCP 半开（NAT 表过期、中间盒静默丢包、客户端切网络）时 socket 既不 emit
 *   `error` 也不 emit `close` —— `watchOnce()` 的 promise **永不 settle**，
 *   `startWatch()` 的 `for (;;)` 退避重连也就**永不触发**。用户表现为
 *   「再也不实时收信」（兜底 alarm 还在，所以邮件没丢），而中继日志上
 *   **一条错误都没有**：连接看起来好好地挂着。
 *
 * 所以这里给「连上 + 收问候语 + `LOGIN` + `SELECT`」这一整段加一个上限，并在
 * 进入 IDLE 时**停表**。
 *
 * ## 为什么单独一个文件
 *
 * 它是这段逻辑里唯一「有状态、会记时、错了就只能靠真机复现」的部分，所以必须可测。
 * 埋在 `scripts/imap-relay.ts` 里的话它**没法被测**：那个文件末尾有 `void main()`，
 * import 它就会真的起一个中继服务（实测：测试里一 import 就占用了 8787 端口）。
 * 现在这个文件没有任何顶层副作用，可以被中继与测试同时安全地引用。
 */

/** watch 连接当前处在哪一段 */
export type WatchConnectionPhase = 'handshake' | 'idle' | 'closed'

export interface WatchHandshakeWatchdogOptions {
  /** 握手阶段的上限（毫秒）。必须是正整数，见 `DEFAULT_WATCH_HANDSHAKE_TIMEOUT_MS` */
  timeoutMs?: number
  /**
   * 判定为「握手挂了」时要做的事（销毁 socket、记下原因给上层）。
   *
   * ⚠ 刻意做成回调而不是在这里直接 `socket.destroy()`：**报什么原因**是中继的事
   *   （它要把「握手超时」与「服务器正常关了连接」区分开，前者必须报错、
   *   后者按设计是静默 resolve），而这里只管「到点了、该动手了」。
   */
  onKill: (reason: string) => void
  /** 日志（由调用方注入，方便测试观察与统一格式） */
  log?: (message: string) => void
}

export interface WatchHandshakeWatchdog {
  /** 握手完成、进入 IDLE 时调用（停表） */
  enterIdle: () => void
  /** 连接结束时调用（停表 + 标终态） */
  close: () => void
  /** 给 socket 的 `timeout` 事件用：超时了该怎么办 */
  onSocketTimeout: () => void
}

/**
 * 默认的握手超时。
 *
 * 真机上 TLS + 登录 + `SELECT` 正常在几秒内完成，30 秒足够宽容；而它决定的是
 * 「半开连接多久被发现」，给太长就等于没加。
 */
export const DEFAULT_WATCH_HANDSHAKE_TIMEOUT_MS = 30_000

/**
 * 把配置值（通常来自环境变量）解析成一个可用的正整数超时。
 *
 * ⚠ 这个函数的存在是为了挡住一个**看起来很蠢但后果很重**的错：
 *   环境变量拼错或写成 `'abc'` 时，`Number.parseInt` 给出 `NaN`，而
 *   `setTimeout(fn, NaN)` 按 1ms 处理、`setTimeout(fn, 0)` 立刻触发 ——
 *   两种都会把**每一条** watch 连接在握手刚开始时就踢掉。
 *   用户侧的表现是「永远连不上、日志疯狂重连」，而代码看起来完全正确。
 *
 * @param raw 原始值（环境变量 / 命令行）
 * @returns 解析后的毫秒数；无效时退回默认值
 */
export function resolveWatchHandshakeTimeoutMs(raw: string | undefined): number {
  if (raw === undefined || raw === '')
    return DEFAULT_WATCH_HANDSHAKE_TIMEOUT_MS
  const parsed = Number.parseInt(raw, 10)
  if (!Number.isFinite(parsed) || parsed <= 0)
    return DEFAULT_WATCH_HANDSHAKE_TIMEOUT_MS
  return parsed
}

/**
 * 建一个握手看门狗。
 *
 * @param options 见 `WatchHandshakeWatchdogOptions`
 * @returns 看门狗；调用方在 `finish()` 里必须调一次 `close()`
 */
export function createWatchHandshakeWatchdog(
  options: WatchHandshakeWatchdogOptions,
): WatchHandshakeWatchdog {
  const timeoutMs = options.timeoutMs ?? DEFAULT_WATCH_HANDSHAKE_TIMEOUT_MS
  const log = options.log ?? (() => {})
  /*
   * ⚠ 不写成 `${timeoutMs / 1000} 秒`：默认值是 30 秒，但测试会把超时压到几百毫秒
   *   （见 `relay-handshake-e2e.spec.ts`），那时「0.6 秒」比「1 秒」诚实 ——
   *   而日志里这个数字正是排查时唯一能对上账的东西。
   */
  const humanTimeout = timeoutMs >= 1000 ? `${timeoutMs / 1000} 秒` : `${timeoutMs} 毫秒`
  let phase: WatchConnectionPhase = 'handshake'

  /*
   * ⚠ 用 socket 的 `timeout` 而不是自己的定时器？两者都要，但**只有这个定时器
   *   是可靠的**：`socket.setTimeout(0)` 关掉的是 socket 自己的计时，
   *   而它是否触发还取决于底层是否真的收到过字节 —— 半开连接恰好是「永远没有
   *   事件」的那一类。所以主手段是这个 `setTimeout`，`onSocketTimeout()` 只是
   *   把 socket 自己的超时事件也接到同一套判断上。
   */
  const timer = setTimeout(() => {
    if (phase !== 'handshake')
      return
    log(`握手超时（${humanTimeout}内没有完成 LOGIN/SELECT）—— 断开重连`)
    /*
     * ⚠ 这里**只**报告，不直接 reject：销毁 socket 会发出 `close`，而上层已经挂了
     *   `socket.on('close', () => finish())` —— 一次销毁就足以让 promise 收尾、
     *   让退避重连跑起来。多写一条 reject 路径反而会让错误分类分叉。
     */
    options.onKill(`握手超时：${humanTimeout}内没有完成 LOGIN/SELECT（TCP 半开？）`)
  }, timeoutMs)

  return {
    enterIdle() {
      phase = 'idle'
      clearTimeout(timer)
    },
    close() {
      phase = 'closed'
      clearTimeout(timer)
    },
    onSocketTimeout() {
      // 只有握手阶段才动手；IDLE 期间不动一条正在推邮件的健康连接
      if (phase !== 'handshake')
        return
      log(`握手阶段套接字超时（${humanTimeout}无数据）—— 断开重连`)
      options.onKill(`握手超时：${humanTimeout}内没有完成 LOGIN/SELECT（TCP 半开？）`)
    },
  }
}
