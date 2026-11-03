import { Buffer } from 'node:buffer'
import { execFileSync } from 'node:child_process'
import { readSync } from 'node:fs'
import process from 'node:process'

/**
 * 占用端口的那个进程的 PID（没有则 null）。
 *
 * 用 `netstat` 而不是「试着连一下」：能连上只说明**有人**在监听，
 * 而我们要的是**杀掉谁**。拿不到 PID 就没法给出可执行的选项。
 *
 * @param port 要查的端口
 * @returns 监听该端口的 PID
 */
export function findPortOwner(port: number): number | null {
  try {
    if (process.platform === 'win32') {
      const output = execFileSync('netstat', ['-ano', '-p', 'TCP'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
      for (const line of output.split('\n')) {
        const parts = line.trim().split(/\s+/)
        // 形如：  TCP    127.0.0.1:41316   0.0.0.0:0    LISTENING    9072
        if (parts.length < 5 || parts[3] !== 'LISTENING')
          continue
        const local = parts[1]
        // 只比端口号：地址可能是 `127.0.0.1:41316` 或 `[::]:41316`
        if (local.slice(local.lastIndexOf(':') + 1) !== String(port))
          continue
        const pid = Number.parseInt(parts[4], 10)
        if (Number.isFinite(pid) && pid > 0)
          return pid
      }
      return null
    }

    const output = execFileSync('lsof', ['-ti', `tcp:${port}`, '-sTCP:LISTEN'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
    const pid = Number.parseInt(output.trim().split('\n')[0] ?? '', 10)
    return Number.isFinite(pid) && pid > 0 ? pid : null
  }
  catch {
    // netstat / lsof 不可用，或没有匹配的监听者
    return null
  }
}

/**
 * 结束一个进程。
 *
 * ⚠ 只接受**具体 PID**，不做「杀掉所有 node」那种事 —— 用户机器上跑着别的
 *   Node 程序（编辑器插件、开发服务器）是常态，按名字杀会连带干掉它们。
 *
 * @param pid 要结束的进程号
 * @returns 是否成功
 */
export function killProcess(pid: number): boolean {
  try {
    if (process.platform === 'win32')
      execFileSync('taskkill', ['/PID', String(pid), '/F'], { stdio: 'ignore' })
    else
      execFileSync('kill', ['-9', String(pid)], { stdio: 'ignore' })
    return true
  }
  catch {
    return false
  }
}

/**
 * 同步地问一个 `[Y/n]` 问题，直接回车算同意。
 *
 * ⚠ 用**同步**读（`readSync`）而不是 `readline.question()`，理由是时机：
 *
 *   这一步发生在任何 `await` 之前，而顶层 await 期间的 stdin 读取在部分终端下会
 *   丢字符（`readline` 的异步 `line` 事件可能在后来的某个 await 之后才被派发，
 *   那时 stdin 的所有权已经准备交给运行期控制台了）。
 *   同步读把「问一个问题」变成一段不被打断的代码，没有这个竞态。
 *
 * ⚠ 非交互式（管道 / 后台服务）时**直接返回 false**，不让调用方卡在一个
 *   永远不来的回答上 —— 中继的长期形态是后台服务，那条路必须能无人工跑通。
 *
 * @param query 提示语（自带 `[Y/n] `）
 * @returns 是否同意
 */
export function confirm(query: string): boolean {
  if (!process.stdin.isTTY)
    return false

  process.stdout.write(query)

  const wasRaw = process.stdin.isRaw
  process.stdin.setRawMode(true)
  process.stdin.resume()

  let answer = ''
  const byte = Buffer.alloc(1)

  try {
    for (;;) {
      if (readSync(0, byte, 0, 1, null) === 0)
        break // EOF：当作「同意默认值」
      const char = byte.toString('utf8')

      if (char === '\u0003') { // Ctrl+C
        process.stdout.write('\n')
        process.exit(130)
      }
      if (char === '\r' || char === '\n')
        break
      // 退格：把已输入的字符删掉（否则用户敲错就只能 Ctrl+C）
      if (char === '\u007F' || char === '\b') {
        if (answer) {
          answer = answer.slice(0, -1)
          process.stdout.write('\b \b')
        }
        continue
      }
      if (char >= ' ') {
        answer += char
        process.stdout.write(char)
      }
    }
  }
  finally {
    // ⚠ 必须还原 raw 模式：后面运行期控制台要用行模式
    process.stdin.setRawMode(wasRaw)
    process.stdin.pause()
    process.stdout.write('\n')
  }

  const normalized = answer.trim().toLowerCase()
  return normalized === '' || normalized === 'y' || normalized === 'yes'
}
