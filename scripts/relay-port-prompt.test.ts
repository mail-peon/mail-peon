/**
 * 用**真 TTY** 验证「端口被占用 → 问一句 [Y/n]」这条交互路径。
 *
 * 为什么必须用真 TTY：`confirm()` 在 `process.stdin.isTTY` 为 false 时**直接返回
 * false**（后台服务形态不能等人回答）。所以管道下跑，这条路径根本不会被执行 ——
 * 普通的自动化测试**永远走不到**它，而它恰恰是用户每天会碰到的那一条。
 *
 * ⚠ 依赖 `winpty`（Git for Windows 自带）。找不到就跳过并说明原因。
 *   winpty 在子进程退出时会自己崩（`ASSERT_CONDITION … cols > 0`，exit code 3），
 *   所以这里**不断言退出码**，只看输出。
 */
import type { ChildProcess } from 'node:child_process'
import type { Server } from 'node:net'
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { createServer } from 'node:net'
import { resolve } from 'node:path'
import process from 'node:process'
import { esnoBin } from './runScript'

const PORT = 18995

/*
 * ⚠ 中继现在是 TypeScript，而 winpty 不能跑 `.cmd` shim ——
 *   所以展开成 `node <abs>/esno.js <abs>/imap-relay.ts`（见 `relay-console.test.ts`）。
 */
const NODE = process.execPath
const RELAY = resolve(process.cwd(), 'scripts/imap-relay.ts')
const ESNO = esnoBin()

/** @returns {string | null} winpty 路径 */
function findWinpty() {
  if (process.platform !== 'win32')
    return null
  const candidates = [
    'D:/Git/usr/bin/winpty.exe',
    'C:/Program Files/Git/usr/bin/winpty.exe',
    `${process.env.ProgramFiles ?? ''}/Git/usr/bin/winpty.exe`,
  ]
  return candidates.find(path => path && existsSync(path)) ?? null
}

const winpty = findWinpty()
if (!winpty) {
  process.stdout.write('⏭  找不到 winpty，跳过「端口占用询问」测试\n')
  process.exit(0)
}

interface CheckResult {
  name: string
  ok: boolean
  detail: string
}

const results: CheckResult[] = []

/**
 * 记一条断言结果并立即打印。
 *
 * @param name 断言描述
 * @param ok 是否通过
 * @param detail 失败时的补充信息
 */
function check(name: string, ok: boolean, detail = ''): void {
  results.push({ name, ok, detail })
  process.stdout.write(`${ok ? '  ✅' : '  ❌'} ${name}${detail ? ` — ${detail}` : ''}\n`)
}

/** 等一会儿（TTY 里的交互只能靠等，没有别的信号可用） */
const wait = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))

/**
 * 归一化 TTY 输出，然后判断是否包含某个片段。
 *
 * ⚠ 这个函数是**必需的**，不是图省事：
 *
 *   `winpty` 会在**第 80 列硬换行**，所以中继打出的
 *   `IMAP 中继已启动：ws://127.0.0.1:18996/`
 *   在测试里收到的是
 *   `IMAP 中继已启\r\n动：ws://127.0.0.1:18996/`。
 *   用 `out.includes('IMAP 中继已启动')` 判断就会**假失败** ——
 *   而假失败的断言比没有断言更糟：它逼着后来的人去改正确的代码。
 *
 *   所以先把 ANSI 转义与所有空白去掉，再比较。
 *
 * @param haystack 待搜索的原始输出
 * @param needle 期望出现的片段
 * @returns 归一化之后 haystack 是否包含 needle
 */
function contains(haystack: string, needle: string): boolean {
  /** 去掉 ANSI 转义与所有空白 */
  const strip = (text: string): string => text
    // eslint-disable-next-line no-control-regex -- ANSI 转义就是以 ESC 开头的
    .replace(/\u001B\[[0-9;]*[A-Z]/gi, '')
    .replace(/\s+/g, '')
  return strip(haystack).includes(strip(needle))
}

/** TTY 子进程的句柄：`out` 随输出增长 */
interface TtyRun {
  out: string
  child: ChildProcess
}

/**
 * 起一个子进程并收集它的输出。
 *
 * @param args `winpty` 之后的参数
 * @param env 追加的环境变量
 * @returns 句柄（`out` 随输出增长）
 */
function spawnInTty(args: string[], env: Record<string, string> = {}): TtyRun {
  /*
   * ⚠ 返回值显式标注成 `TtyRun` 是**必需的**，不是图省事：
   *
   *   `spawn` 在 `stdio: ['pipe','pipe','pipe']` 下的返回类型是一个**交叉类型**，
   *   TS 会因为其中 `stdin` 的类型冲突把整个交叉类型收窄成 `never` ——
   *   于是 `child.kill()` 报「Property 'kill' does not exist on type 'never'」。
   *   标注返回类型之后 TS 用我们的类型，不去推那个交叉类型。
   */
  const child = spawn(winpty ?? '', ['-Xallow-non-tty', '-Xplain', ...args], {
    env: { ...process.env, ...env },
    stdio: ['pipe', 'pipe', 'pipe'],
  })

  const state: TtyRun = { out: '', child }

  child.stdout?.on('data', (chunk) => {
    state.out += chunk.toString()
  })
  child.stderr?.on('data', (chunk) => {
    state.out += chunk.toString()
  })
  return state
}

/**
 * 测试主体。
 *
 * ⚠ 包在 `main()` 里而**不是**用顶层 await：根 `package.json` 没有
 *   `type: "module"`，esno 会把 `.ts` 编成 CommonJS，而顶层 await 在 CJS 下
 *   直接报错（运行期是 `ERR_REQUIRE_ASYNC_MODULE`，类型检查期是 TS1378）。
 *   见 `relay-kill.ts` 里同一处说明。
 */
async function main(): Promise<void> {
  // -------------------------------------------------------------------------
  // 先把端口占住
  // -------------------------------------------------------------------------

  const blocker: Server = createServer()
  await new Promise<void>((resolve) => {
    blocker.listen(PORT, '127.0.0.1', () => resolve())
  })

  // 从 blocker 自己的句柄拿 PID，避免依赖 netstat 的格式
  const blockerPid = process.pid
  process.stdout.write(`  → 已用 PID ${blockerPid} 占住端口 ${PORT}\n`)

  // ---------------------------------------------------------------------------
  // 1) 回答 n：不该杀、不该启动
  // ---------------------------------------------------------------------------

  {
    const run = spawnInTty([NODE, ESNO, RELAY, '--port', String(PORT)])
    await wait(2500)

    check('提示端口被占用', contains(run.out, `端口 ${PORT} 已被占用`))
    check('提示里带上占用者 PID', contains(run.out, `PID ${blockerPid}`))
    check('给出 [Y/n] 询问', contains(run.out, '[Y/n]'))

    run.child.stdin?.write('n\n')
    await wait(2000)

    check('回答 n 后不杀进程', !contains(run.out, '已结束 PID'))
    check('回答 n 后给出替代命令', contains(run.out, 'pnpm relay --port'))
    check('回答 n 后进程退出', run.child.exitCode !== null, `exitCode=${run.child.exitCode}`)

    // 端口仍被占着，说明确实没杀
    check('原占用进程仍活着', blocker.listening === true)

    if (run.child.exitCode === null)
      run.child.kill()
  }

  // ---------------------------------------------------------------------------
  // 2) 回答 y：杀掉占用者并启动
  // ---------------------------------------------------------------------------

  {
    /*
     * ⚠ 这里**必须**换一个占用者：上面那条用例验证了「回答 n 不会杀」，
     *   所以 blocker（本测试进程自己）还活着，而我们不能杀掉自己。
     *   用一个独立的子进程占端口。
     */
    const holder = spawnInTty([process.execPath, '-e', `
      const { createServer } = require('node:net')
      const s = createServer()
      s.listen(${PORT + 1}, '127.0.0.1', () => console.log('HOLDER_READY'))
    `])
    await wait(2000)
    check('第二个占用者已就绪', contains(holder.out, 'HOLDER_READY'))

    const run = spawnInTty([NODE, ESNO, RELAY, '--port', String(PORT + 1)])
    await wait(2500)
    check('提示端口被占用（第二例）', contains(run.out, `端口 ${PORT + 1} 已被占用`))

    run.child.stdin?.write('y\n')
    await wait(3500)

    check('回答 y 后杀掉了占用者', contains(run.out, '已结束 PID'))
    check('回答 y 后中继启动成功', contains(run.out, 'IMAP 中继已启动'))
    check('启动后仍显示运行期控制台', contains(run.out, '[r] 重启'))

    if (run.child.exitCode === null)
      run.child.kill()
    if (holder.child.exitCode === null)
      holder.child.kill()
  }

  // ---------------------------------------------------------------------------
  // 3) 直接回车 = 同意默认值（Y）
  // ---------------------------------------------------------------------------

  {
    const holder = spawnInTty([process.execPath, '-e', `
      const { createServer } = require('node:net')
      const s = createServer()
      s.listen(${PORT + 2}, '127.0.0.1', () => console.log('HOLDER_READY'))
    `])
    await wait(2000)

    const run = spawnInTty([NODE, ESNO, RELAY, '--port', String(PORT + 2)])
    await wait(2500)

    run.child.stdin?.write('\r')
    await wait(3500)

    check('直接回车按「同意」处理', contains(run.out, 'IMAP 中继已启动'))

    if (run.child.exitCode === null)
      run.child.kill()
    if (holder.child.exitCode === null)
      holder.child.kill()
  }

  blocker.close()

  process.stdout.write('\n--- 第二例的完整输出 ---\n')
  process.stdout.write(`${results.map(r => `${r.ok ? '✅' : '❌'} ${r.name}`).join('\n')}\n---\n`)

  const failed = results.filter(r => !r.ok)
  process.stdout.write(failed.length ? `\n失败 ${failed.length} 项\n` : '\n端口占用询问全部通过\n')
  process.exitCode = failed.length ? 1 : 0
}

void main()
