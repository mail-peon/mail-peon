import process from 'node:process'
import * as readline from 'node:readline'
import { PORT } from './config'
import { log } from './logger'
import { confirm, findPortOwner, killProcess } from './ports'
import { createRelayServer } from './server'
// ---------------------------------------------------------------------------
// 启动 + 交互式控制台
// ---------------------------------------------------------------------------

const relay = createRelayServer()

/**
 * 启动；端口被占用时**问一句**要不要杀掉占用者。
 *
 * 原来的做法是直接失败并让用户自己去执行 `pnpm relay:kill` —— 那是两步操作，
 * 而用户此刻的意图很明确（「我要把中继跑起来」），多一步只是摩擦。
 *
 * @returns 是否启动成功
 */
async function startWithPortCheck(): Promise<boolean> {
  try {
    await relay.start()
    return true
  }
  catch (error) {
    // `EADDRINUSE` 是 `net` 抛出来的唯一带 `code` 的错误（同 socket 的 error）
    if ((error as NodeJS.ErrnoException).code !== 'EADDRINUSE')
      throw error
  }

  const owner = findPortOwner(PORT)

  if (owner === null) {
    log(`端口 ${PORT} 被占用，但查不出是哪个进程（netstat / lsof 不可用）。`)
    log(`换一个端口：  pnpm relay --port ${PORT + 1}`)
    return false
  }

  /*
   * ⚠ 提示里要说清「上次的中继可能没退干净」这件事。
   *   用户的直觉是「我明明关了终端」，不说原因的话他会怀疑是脚本的问题。
   */
  log(`端口 ${PORT} 已被占用（PID ${owner}）。`)
  log('  多半是上一次的中继没退干净 —— 关掉终端窗口不一定会带走它')
  log('  （`pnpm relay` 会再 fork 一层 node，IDE 的「停止」有时只结束了外层 shell）。')

  if (!confirm(`要结束 PID ${owner} 并用端口 ${PORT} 启动吗？[Y/n] `)) {
    log(`已取消。也可以换个端口：  pnpm relay --port ${PORT + 1}`)
    return false
  }

  if (!killProcess(owner)) {
    log(`无法结束 PID ${owner}（可能需要管理员权限）。`)
    log(`换一个端口：  pnpm relay --port ${PORT + 1}`)
    return false
  }

  // 给内核一点时间回收监听套接字，否则紧接着的 listen 仍可能 EADDRINUSE
  await new Promise(resolve => setTimeout(resolve, 300))

  try {
    await relay.start()
    log(`已结束 PID ${owner}`)
    return true
  }
  catch (error) {
    /*
     * ⚠ `catch` 的形参在 `strict` 下是 `unknown`，这里断言成 `Error` 是**收窄**、
     *   不是掩盖：能走到这里的只有 `relay.start()`，而它只会转发 ws 的 `error`
     *   事件（那一定是 `Error`）。下面 `main()` / `restart()` 里是同一套写法。
     */
    log(`结束 PID ${owner} 后仍无法启动：${(error as Error).message}`)
    return false
  }
}

/**
 * 入口。
 *
 * ⚠ 必须包在 `async function main()` 里，**不能**在模块顶层直接 `await`：
 *   根 `package.json` 没有 `"type": "module"`，esno（esbuild）会把本文件编译成
 *   CommonJS，而 CJS 输出格式下 esbuild 直接拒绝顶层 await ——
 *   「Top-level await is currently not supported with the "cjs" output format」。
 *   症状是中继**一个字节都不发**：`pnpm relay` 与 `pnpm relay:test` 全部起不来。
 *
 *   给根 `package.json` 加 `"type": "module"` 也能绕开，但那会改掉**整个仓库**的
 *   模块解析语义（vite 配置、构建产物、既有脚本），代价远大于收益；
 *   包一层 `main()` 只影响这一个文件。
 *
 * ⚠ 顺序不能动：先启动服务（`startWithPortCheck` 里含端口被占用时的 `[Y/n]` 提问），
 *   失败就 `exit(1)`，**成功之后**才决定要不要开交互式控制台。
 */
async function main(): Promise<void> {
  let started = false
  try {
    started = await startWithPortCheck()
  }
  catch (error) {
    log(`启动失败：${(error as Error).message}`)
  }

  if (!started)
    process.exit(1)

  startConsole()
}

/**
 * 交互式控制台：`q` 退出、`r` 重启，都要按回车。
 *
 * ⚠ 只在**交互式终端**里启用（`process.stdin.isTTY`）。
 *
 *   中继的长期形态是后台服务（见 `ai-docs/decisions/relay-deployment.md`），
 *   而服务是没有 TTY 的。不加这个判断的话，后台运行时 `readline` 会挂在
 *   一个永远不来的 stdin 上 —— 轻则无输出，重则进程被 stdin 的 EOF 直接带走。
 */
function startConsole(): void {
  if (!process.stdin.isTTY) {
    log('（非交互式终端：q 退出 / r 重启 不可用，用 Ctrl+C 结束）')
    return
  }

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout })

  rl.setPrompt('中继运行中 › [r] 重启  [q] 退出\n> ')
  rl.prompt()

  rl.on('line', (line) => {
    const command = line.trim().toLowerCase()

    if (command === 'q' || command === 'quit' || command === 'exit') {
      rl.close()
      return
    }

    if (command === 'r' || command === 'restart') {
      void restart()
      return
    }

    if (command)
      process.stdout.write(`未知命令「${command}」—— 可用：[r] 重启 / [q] 退出\n`)

    rl.prompt()
  })

  rl.on('close', () => {
    void shutdown('用户退出')
  })
}

/** 控制台的 `r`：重启服务（`stop()` 之后再 `start()`，失败则留着控制台） */
async function restart(): Promise<void> {
  process.stdout.write('正在重启中继…\n')
  await relay.stop()
  try {
    await relay.start()
  }
  catch (error) {
    log(`重启失败：${(error as Error).message}`)
    // 重启失败就把控制台留着，用户可以再敲一次 r 或 q
    process.stdout.write('> ')
  }
}

/**
 * 退出。
 *
 * ⚠ 必须**主动**关掉服务与 readline：不关的话 `server` 还持着监听句柄，
 *   进程不会自己结束 —— 用户敲了 `q` 却发现终端卡在那里。
 *
 * @param reason 退出原因（`q` / `Ctrl+C` / `SIGTERM` …，只进日志）
 */
async function shutdown(reason: string): Promise<void> {
  process.stdout.write(`\n正在停止中继（${reason}）…\n`)
  await relay.stop()
  process.exit(0)
}

/** Install process handlers before the first asynchronous startup step. */
export function runRelayCli(): void {
  /**
   * 最后一道防线：**任何未捕获异常都不该让中继进程退出**。
   *
   * 中继是后台常驻进程，崩了之后用户看到的是「扩展突然连不上」，
   * 而没有任何界面提示他去重启。宁可这一条连接废掉，也不要整个进程没了。
   */
  process.on('uncaughtException', (error) => {
    log(`⚠️  未捕获异常（已忽略，进程继续运行）：${error?.stack ?? error}`)
  })

  process.on('unhandledRejection', (reason) => {
    log(`⚠️  未处理的 Promise 拒绝（已忽略）：${reason instanceof Error ? reason.stack : String(reason)}`)
  })

  // Ctrl+C / kill 也要走同一套清理（否则端口可能被 TIME_WAIT 占住一会儿）
  process.on('SIGINT', () => {
    void shutdown('Ctrl+C')
  })

  process.on('SIGTERM', () => {
    void shutdown('SIGTERM')
  })

  /*
   * ⚠ 调用点必须在**文件末尾**，不能提到上面去：`main()` 会一路同步执行到第一个
   *   `await`（也就是 `relay.start()` 里那个等 `listening` 的 Promise），
   *   而 `process.on('SIGINT'…)` 与会话控制的注册都在这之前 ——
   *   提前调用就等于让「注册信号处理」跑到「服务开始监听」之后，那是行为变化。
   */
  void main()
}
