import type { ChildProcess } from 'node:child_process'
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import process from 'node:process'

/**
 * 把**真中继进程**拉起来给 Vitest 用（`imap-e2e.spec.ts` / `relay-watch.spec.ts`）。
 *
 * ## 为什么不能直接 `spawn(process.execPath, ['scripts/imap-relay.ts'])`
 *
 * Node 不认 `.ts`。中继现在是 TypeScript，必须经 **esno** 跑。
 *
 * ⚠ 这里**不复用** `scripts/runScript.ts` 的 `spawnScript()`：
 *   那个模块 import 了 `node:child_process` / `node:module`，而 Vitest 这两个
 *   suite 跑在 jsdom 环境里，从 `src/` 反向 import `scripts/` 会让测试环境与
 *   脚本环境混在一起。两边各自算一次 esno 路径更省事，代价只是几行重复。
 *
 * ## 为什么要走 `createRequire` 而不是写死路径
 *
 * pnpm 的 `node_modules` 布局可能是提升的（`node_modules/esno/…`），
 * 也可能在 `.pnpm` 里。写死一种会在另一种下失败 —— 而失败信息是
 * 「中继启动超时」，完全指不到真正的原因（那正是这类 bug 最难查的地方）。
 *
 * 实测 esno 的 `package.json` **没有 `exports` 字段**，所以
 * `node --import esno/register` 与 `node --import tsx` **都拿不到 loader 入口**；
 * 直接执行它的 bin 文件是唯一稳的路子。
 */

/** esno 的 bin 入口绝对路径 */
function esnoBin(): string {
  /*
   * ⚠ 从**仓库根**拼路径，而不是 `createRequire(import.meta.url)`：
   *   Vitest 的工作目录就是仓库根（`package.json` 所在处），
   *   而 `import.meta.url` 在这个 jsdom 环境里指向 `src/adapters/mail/testing/`，
   *   靠它往上走要数四层目录 —— 那种「数层数」的代码在目录一挪动时就悄悄失效。
   */
  const candidates = [
    resolve(process.cwd(), 'node_modules/esno/esno.js'),
    resolve(process.cwd(), 'node_modules/.pnpm/esno@4.8.0/node_modules/esno/esno.js'),
  ]

  const found = candidates.find(path => existsSync(path))
  if (!found) {
    throw new Error(
      'E2E 测试需要 esno（中继是 TypeScript，靠它执行）。请先执行 `pnpm install`。'
      + `已找过：${candidates.join(' / ')}`,
    )
  }
  return found
}

/** 中继进程就绪时打印的那行日志（用它当「可以开始连了」的信号） */
const READY_MARKER = 'IMAP 中继已启动'

/**
 * 启动中继并等它打印就绪日志。
 *
 * ⚠ 等**日志**而不是 `setTimeout(2000)`：固定等待要么在慢机器上不够
 *   （测试假失败）、要么在快机器上白等。日志是它自己给出的「我起来了」信号。
 *
 * @param port 中继监听端口
 * @param env 追加的环境变量
 * @returns 子进程句柄（调用方负责在 `afterAll` 里 kill）
 */
export async function startRelayForTest(
  port: number,
  env: Record<string, string> = {},
): Promise<ChildProcess> {
  const child = spawn(process.execPath, [
    esnoBin(),
    resolve(process.cwd(), 'scripts/imap-relay.ts'),
  ], {
    env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', ALLOWED_HOSTS: '127.0.0.1', ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  })

  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`中继启动超时（未看到「${READY_MARKER}」）`)), 15000)

    // 类型由 Node 的 `Readable` 重载给出，不用手写 `chunk: Buffer`
    child.stdout?.on('data', (chunk) => {
      if (chunk.toString().includes(READY_MARKER)) {
        clearTimeout(timer)
        resolve()
      }
    })

    /*
     * ⚠ 也要听 stderr：中继启动失败（例如 esno 编译报错、端口被占）时
     *   错误信息走 stderr，而只等 stdout 的话我们得等到 15 秒超时才知道出事了 ——
     *   那时真正的原因早就被淹没了。
     */
    child.stderr?.on('data', (chunk) => {
      const text = chunk.toString()
      if (text.includes(READY_MARKER))
        return
      clearTimeout(timer)
      reject(new Error(`中继启动失败：${text.slice(0, 500)}`))
    })

    child.once('error', reject)
  })

  return child
}
