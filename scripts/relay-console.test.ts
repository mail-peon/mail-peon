/**
 * 用**真 TTY** 验证交互控制台：q 退出、r 重启。
 *
 * 为什么值得单独验：控制台那一段是「只在交互式终端里生效」的代码 ——
 * CI / 管道下 `process.stdin.isTTY` 恒为 false，所以普通的自动化测试
 * **永远走不到**那些分支。不验的话，「敲了 r 没反应」只能靠人肉发现。
 *
 * ⚠ 依赖 `winpty`（Git for Windows 自带）。找不到就**跳过并说明原因**，
 *   而不是让 `pnpm lint` 或 CI 因为一个环境差异而失败。
 */
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import process from 'node:process'
import { esnoBin } from './runScript'

/*
 * ⚠ 中继现在是 TypeScript，winpty 又不能跑 `.cmd` shim ——
 *   所以这里展开成 winpty 能吃的形式：`node <abs>/esno.js <abs>/imap-relay.ts`。
 *   `spawnScript` 返回的是 ChildProcess，而 winpty 需要自己当被包裹的程序，
 *   所以这里不用它，只借 `esnoBin()`。
 */
const NODE = process.execPath
const RELAY = resolve(process.cwd(), 'scripts/imap-relay.ts')
const ESNO = esnoBin()

/** 找 winpty；找不到返回 null */
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
  process.stdout.write('⏭  找不到 winpty（Git for Windows 自带），跳过交互控制台测试\n')
  process.exit(0)
}

const child = spawn(winpty, ['-Xallow-non-tty', '-Xplain', NODE, ESNO, RELAY], {
  env: { ...process.env, PORT: '18993', HOST: '127.0.0.1' },
  stdio: ['pipe', 'pipe', 'pipe'],
})

let out = ''
child.stdout.on('data', (c) => {
  out += c.toString()
})
child.stderr.on('data', (c) => {
  out += c.toString()
})

/** 等一会儿（TTY 里的交互只能靠等，没有别的信号可用） */
const wait = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms))
const countStarts = (): number => (out.match(/IMAP 中继已启动/g) ?? []).length

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

/**
 * 测试主体。
 *
 * ⚠ 包在 `main()` 里而**不是**用顶层 await：根 `package.json` 没有
 *   `type: "module"`，esno 会把 `.ts` 编成 CommonJS，而顶层 await 在 CJS 下
 *   直接报错（运行期是 `ERR_REQUIRE_ASYNC_MODULE`，类型检查期是 TS1378）。
 *   见 `relay-kill.ts` 里同一处说明。
 */
async function main(): Promise<void> {
  await wait(3000)
  check('中继启动并监听', countStarts() === 1, `已启动 ${countStarts()} 次`)
  check('控制台提示可用（说明识别为 TTY）', out.includes('[r] 重启'), out.includes('非交互式') ? '被当成非交互式了' : '')

  process.stdout.write('  → 发送 r（重启）\n')
  child.stdin.write('r\n')
  await wait(3000)
  check('r 之后重新监听（启动日志出现第二次）', countStarts() === 2, `已启动 ${countStarts()} 次`)
  check('重启后进程仍存活', child.exitCode === null)

  process.stdout.write('  → 发送未知命令 x\n')
  child.stdin.write('x\n')
  await wait(800)
  check('未知命令给出提示', out.includes('未知命令'))

  process.stdout.write('  → 发送 q（退出）\n')
  child.stdin.write('q\n')
  await wait(2500)
  check('q 之后进程退出', child.exitCode !== null, `exitCode=${child.exitCode}`)
  check('走了正常退出路径（打印了停止提示）', out.includes('正在停止中继'))

  /*
   * ⚠ 这里**不**断言退出码为 0。
   *
   * winpty 在子进程退出时自己会崩（`ASSERT_CONDITION(...cols > 0 && rows > 0)`，
   * exit code 3）—— 那是 winpty 的收尾问题，不是中继的。中继实际的退出码
   * 由「非 TTY 路径」与代码审查共同保证（`shutdown()` 里是 `process.exit(0)`）。
   * 断言一个被工具污染的值，只会让测试变成必须绕过的东西。
   */

  if (child.exitCode === null)
    child.kill()

  process.stdout.write('\n--- 中继输出 ---\n')
  /*
   * 去掉 ANSI 转义序列再打出来：`\u001B` 是 ESC。
   * eslint-disable 是必要的 —— 这条规则的本意是「别在正则里塞控制字符」，
   * 而这里**就是要**匹配 ESC 这个控制字符（那是 ANSI 转义的定义）。
   */
  // eslint-disable-next-line no-control-regex -- 见上：这里就是要匹配 ESC
  process.stdout.write(out.replace(/\u001B\[[0-9;]*[A-Z]/gi, ''))
  process.stdout.write('\n---\n')

  const failed = results.filter(r => !r.ok)
  process.stdout.write(failed.length ? `\n失败 ${failed.length} 项\n` : '\n交互控制台全部通过\n')
  process.exitCode = failed.length ? 1 : 0
}

void main()
