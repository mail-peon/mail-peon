import type { IncomingMessage } from 'node:http'
import type { WebSocket } from 'ws'
import type { ClientFrame, RelayTarget } from './protocol'
import { WebSocketServer } from 'ws'
import { ALLOWED_HOSTS, HOST, PORT, RELAY_TOKEN } from './config'
import { log, logListening } from './logger'
import { isWatchRequest, reject, sendToClient } from './protocol'
import { hostAllowed, NoTargetError, resolveTarget } from './target'
import { startPassthrough } from './tunnel'
import { startWatch } from './watch'

/**
 * 中继服务的启停句柄。
 *
 * ⚠ 做成「工厂 + 显式启停」而不是模块加载时就 `listen`：这样 `r`（重启）
 *   才有一个干净的对象可以关掉重建。模块顶层直接监听的话，重启只能靠
 *   `process.exit` 让外部（pm2 之类）拉起来 —— 而交互式控制台里没有那个外部。
 */
interface RelayServer {
  /** 开始监听。端口被占用 / 服务错误时 reject */
  start: () => Promise<void>
  /** 停止监听，并**主动**断开所有活着的连接（否则 IMAP 的 IDLE 会把重启卡住） */
  stop: () => Promise<void>
  /** 扩展里该填的地址 */
  url: () => string
}

/**
 * 建立中继的 WebSocket 服务。
 *
 * @returns 中继服务的启停句柄
 */
export function createRelayServer(): RelayServer {
  /**
   * 当前的服务对象。
   *
   * ⚠ 可能非空但**没在监听**（上一次失败尝试留下的残留，见下面 `listening`），
   *   所以判断「是否在跑」永远要用 `listening`，不要用 `server !== null`。
   */
  let server: WebSocketServer | null = null

  /**
   * 「当前真的在监听」。
   *
   * ⚠ 不能拿 `server !== null` 当这个判断 —— 那正是修之前的一个真 bug：
   *
   *   端口被占用时 `new WebSocketServer(...)` 已经建了对象、`server` 也被赋了值，
   *   然后 `error` 事件（EADDRINUSE）让 `start()` 抛出。**但 `server` 没有被清回去**，
   *   于是「杀掉占用者之后再 start()」会在第一行 `if (server) return` 处直接返回：
   *   监听确实成功了（那个对象自己还在监听），但 `logListening()` 永远不会执行 ——
   *   用户看到的是「已结束 PID xxx」之后**没有**启动日志，只有一个控制台提示。
   *
   *   所以用一个只在 `listening` 之后才置位的标志，并且失败时把残留对象清掉。
   */
  let listening = false

  /** 当前活着的连接（重启时要主动断掉它们） */
  const connections = new Set<WebSocket>()

  async function start(): Promise<void> {
    if (listening)
      return

    /*
     * 上一次尝试失败时残留的对象：先彻底丢掉它。
     *
     * 走到这里说明 `listening` 是 false，但 `server` 可能非空（失败的尝试留下的）。
     * 不清理的话它会一直挂着一个坏掉的监听器。
     */
    if (server) {
      const stale = server
      server = null
      try {
        stale.close()
      }
      catch {}
    }

    /*
     * ⚠ 赋给局部 const 再用：`server` 是可变绑定，TS 在 `await` 之后会**丢掉收窄**
     *   （闭包可能在赋值之后再执行），于是 `server.once(...)` 报「可能是 null」。
     *   用局部 const 把收窄固定下来，顺便让这段读起来也更清楚。
     */
    const created = new WebSocketServer({ host: HOST, port: PORT })
    server = created

    created.on('connection', onConnection)
    connections.clear()

    try {
      await new Promise<void>((resolve, reject) => {
        /*
         * ⚠ 两个 handler **互不引用**，靠一个 `settled` 标志去重。
         *
         *   互相 `off()` 的写法（`onError` 里摘 `onListening`、反之亦然）会让
         *   「谁先声明」变成必须推理的事，而 `no-use-before-define` 会直接拦下来。
         *   用 `once` + 标志位更简单，也不依赖声明顺序。
         */
        let settled = false
        const onListening = () => {
          if (settled)
            return
          settled = true
          // ⚠ 保留显式实参：`Promise<void>` 的 resolve 接受 `undefined`，
          //   而这里要的是「与改动前一模一样的那次调用」，不要顺手写成 `resolve()`
          resolve(undefined)
        }
        const onError = (error: Error) => {
          if (settled)
            return
          settled = true
          reject(error)
        }
        // `once` 保证两个监听器各自最多触发一次，且触发后自动摘除
        created.once('listening', onListening)
        created.once('error', onError)
      })
    }
    catch (error) {
      /*
       * ⚠ 失败时**必须**清掉残留：留着它会让下一次 `start()` 误以为「已经在跑了」。
       *   见上面 `listening` 的说明。
       */
      if (server === created)
        server = null
      try {
        created.close()
      }
      catch {}
      throw error
    }

    listening = true

    created.on('error', (error) => {
      // 运行期错误不该让进程退出（`uncaughtException` 兜底也覆盖不到 EventEmitter）
      log(`⚠️  服务错误（已忽略，进程继续运行）：${error.message}`)
    })

    logListening()
  }

  async function stop(): Promise<void> {
    const current = server
    // ⚠ 用 `listening` 而不是 `server`：失败的尝试会留下一个非空但没在监听的
    //   对象（见 `listening` 的说明），那种情况下没有什么可关的
    if (!current || !listening)
      return
    server = null
    listening = false

    /*
     * 顺序很重要：先主动断开所有连接，再 `close()`。
     *
     * `ws` 的 `server.close()` 会**等现有连接自己结束**，而 IMAP 连接可以空闲挂
     * 十几分钟（IDLE 超时就是 15 分钟）—— 不主动断的话，「重启」会卡在那里，
     * 用户看到的是「敲了 r 但没反应」。
     */
    for (const ws of connections) {
      try {
        ws.close(1001, 'relay restarting')
      }
      catch {}
    }
    connections.clear()

    await new Promise<void>((resolve) => {
      current.close(() => resolve(undefined))
      // 兜底：某些环境下 close 回调可能不来
      setTimeout(resolve, 2000)
    })
  }

  /**
   * 连接进来：**先看第一条消息**决定这条连接是哪种中继。
   *
   * 两种用法共用同一个 WebSocket 端点，靠第一帧区分：
   *
   * | | 第一帧 | 用途 |
   * | --- | --- | --- |
   * | **透传** | 二进制（IMAP 命令） | 插件抓取时建立一次，用完就关 |
   * | **watch** | 文本 JSON（`__watch: 1`） | 常驻，中继替插件挂 `IDLE` 并推新邮件 |
   *
   * ## ⚠ 两个必须避开的坑（都真机上踩过）
   *
   * **① 建 TCP 必须是「立刻」，不能等到第一条消息。**
   * 有些真实用法（以及证书校验这类测试）**一个字节都不发**，只是等中继去连、
   * 然后观察结果 —— 不管是「TLS 握手失败被关掉」还是「服务器先说话」。
   * 把连接推迟到收帧之后，它们就永远等不到结果，表现成「卡住」。
   *
   * **② 分流必须在**建 TCP 之后、**转发之前**做。**
   * watch 请求是**文本 JSON**，而透传路径会把任何帧原样写进 TCP ——
   * 顺序错了就会把 watch 的 JSON 当成 IMAP 命令发给邮件服务器。
   * 所以第一条消息由这里拦截判断，判断为 watch 时**先关掉刚建的 TCP** 再走 watch。
   * （代价是 watch 会在邮件服务器上留下一条「连上就断」的记录，而服务器
   *   一个字节都没收到 —— 它看不到任何命令，这是可接受的。）
   *
   * **③ 不要用「`once('message')` 置标志 + `setImmediate` 判断」分流。**
   * 那是**结构性竞态**：`setImmediate` 在轮询阶段结束时就跑，而 WebSocket 的帧解析
   * 是异步的 —— 消息还没派发，判断已经做了。于是连接被同时当成两种中继：
   * watch 的 JSON 被当成 IMAP 命令发出去，透传路径又因为 URL 里没有 `?host=`
   * 直接 `close(1008)`。症状是「客户端一条消息都收不到」，日志里只有一条 1008。
   *
   * **④ 策略检查必须**同步做。**
   * 被拒的连接（白名单外、`tls=0` + 993）不发任何字节，任何「等消息再决定」的
   * 写法都会让它们一直挂着 —— 那是「被静默放行」，安全检查最不该有的失败方式。
   *
   * 不使用 `ws.pause()` / `resume()` 做分流：ws 的流控与背压逻辑共用同一个状态，
   * 在连接初期介入会和 `startPassthrough` 里的 `wsPaused` 打架（实测字节全丢）。
   *
   * @param ws 刚升级完成的 WebSocket 连接
   * @param request 升级请求（只看 `url`：目标与 token 都在 query / path 里）
   */
  function onConnection(ws: WebSocket, request: IncomingMessage): void {
    connections.add(ws)
    ws.on('close', () => connections.delete(ws))

    /**
     * 解析目标。`null` = **这个 URL 里没有目标**，也就是「还判断不出这是哪种连接」。
     *
     * ⚠ 这个区分很关键：watch 请求的 URL **故意不带** `?host=` ——
     *   目标在第一条消息的 JSON 里。所以「URL 里没有目标」不能直接当成错误拒掉，
     *   否则 watch 连接会在发出请求之前就被 `close(1008)`，
     *   而症状是**客户端一条消息都收不到**（看起来像中继没工作）。
     */
    let target: RelayTarget | null = null
    try {
      target = resolveTarget(request.url)
    }
    catch (error) {
      /*
       * ⚠ 只有「URL 里没有目标」才留着等第一条消息（见 `NoTargetError` 的说明）。
       *   其它解析错误（`tls=0` 连 993、本机地址不在白名单…）必须**立刻拒绝** ——
       *   被拒的连接不发任何字节，等消息等于永远不等，那就是「被静默放行」。
       */
      if (!(error instanceof NoTargetError)) {
        reject(ws, error)
        return
      }
      target = null
    }

    /**
     * 透传路径的「转发这一帧」入口。
     *
     * ⚠ 用 `let` 而不是 `const`：URL 里没有目标时它**还没被创建**
     *   （那种连接可能是 watch，要等第一条消息才知道）。
     */
    let forward: ((frame: ClientFrame | null) => void) | null = null

    /** 有目标时才做策略检查；没有目标的连接要等第一条消息 */
    if (target) {
      if (RELAY_TOKEN && target.token !== RELAY_TOKEN) {
        log(`拒绝：token 不匹配（${target.host}:${target.port}）`)
        reject(ws, new Error('invalid token'))
        return
      }

      if (ALLOWED_HOSTS.length && !hostAllowed(target.host)) {
        log(`拒绝：${target.host} 不在白名单内`)
        reject(ws, new Error('host not allowed'))
        return
      }

      /*
       * 先把 TCP/TLS 建起来（说明 ①），再挂上分流。
       *
       * `startPassthrough` 返回一个「转发这一帧」的函数 —— 分流判断为透传时
       * 把第一帧交给它（说明 ②：那一帧被 `once('message')` 消耗掉了，
       * 不补投的话客户端的第一个 IMAP 命令就丢了，服务器一直等不到命令）。
       */
      forward = startPassthrough(ws, target, (error) => {
        // `null` = 连接建立成功；只有失败时才记日志
        if (error)
          log(`CONNECT ${target.host}:${target.port} 失败：${error.message}`)
      })
      if (!forward)
        return
    }

    ws.once('message', (data, isBinary) => {
      if (!isBinary) {
        /*
         * ⚠ 先落成 `unknown` 再判断：这段 JSON **完全来自网络**，
         *   把 `JSON.parse` 的结果直接当对象用，等于让「客户端发了个数字」
         *   这种输入一路穿到下面的属性读取。判断由 `isWatchRequest` 负责。
         */
        let parsed: unknown = null
        try {
          parsed = JSON.parse(data.toString())
        }
        catch {
          parsed = null
        }

        if (isWatchRequest(parsed)) {
          // 这条连接是 watch —— 把刚建的透传连接关掉（说明 ②）
          forward?.(null)
          /*
           * ⚠ 形参标 `Error` 是**准确**的，不是为了让报错消失：`startWatch` 里所有
           *   失败路径都是 `throw new Error(...)` / `reject(new Error(...))`。
           *   必须显式标注的原因在 `Promise.catch` 的签名上 —— 它的形参是 `any`，
           *   不标就等于这里没有类型（而 `error.message` 的语义与改动前一致）。
           */
          startWatch(ws, parsed).catch((error: Error) => {
            log(`watch 启动失败：${error.message}`)
            sendToClient(ws, { type: 'state', state: 'failed', error: error.message })
            try {
              ws.close(1011, 'watch failed')
            }
            catch {}
          })
          return
        }
      }

      /*
       * 走到这里说明它不是 watch 请求。
       *
       * 如果 URL 里本来就没有目标（`target === null`），那这条连接既没有目标
       * 也不是 watch —— 现在才报错。这时报是安全的：watch 已经排除了，
       * 而透传连接本来就会立刻发第一条命令，用户不会白等。
       */
      if (!target) {
        reject(ws, new Error('缺少目标 host（用 /host:port 或 ?host=&port=）'))
        return
      }

      forward?.({ data, isBinary })
    })
  }

  return {
    start,
    stop,
    /** 扩展里该填的地址 */
    url: () => (HOST === '127.0.0.1' ? `ws://127.0.0.1:${PORT}/` : 'wss://<你的域名>/'),
  }
}
