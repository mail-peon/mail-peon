/**
 * 释放中继占用的端口。
 *
 * ## 为什么需要它
 *
 * 「我明明关了终端，怎么端口还被占用？」—— 这不是错觉，而是三个原因叠在一起：
 *
 * 1. `pnpm relay` 会再 fork 一层 `node`（`pnpm` → `esno` → `node`）。
 *    关掉终端窗口不一定把子进程带走。
 * 2. 在 IDE 的终端里按「停止」有时只结束了外层 shell。
 * 3. 如果中继是被当成**后台任务**起的（例如编辑器插件、`Start-Job`），
 *    它压根就没有前台窗口可以关。
 *
 * 于是那个进程会一直活着并占着端口，下次启动就报 EADDRINUSE。
 *
 * ## 它杀什么
 *
 * **只杀两类进程**，不做「杀掉所有 node」那种事：
 *   - 正在**监听目标端口**的进程（它就是占用者）
 *   - 命令行里含 `imap-relay` 的进程（就是中继本身，可能换了端口在跑）
 *
 * 用法：
 *   pnpm relay:kill          # 默认端口 8787
 *   pnpm relay:kill 8788
 */

import { execFileSync } from 'node:child_process'
import process from 'node:process'

/**
 * 跑一条命令并把 stdout 当文本拿回来。
 *
 * @param command 可执行文件
 * @param args 参数
 * @returns stdout；命令失败时返回空串（调用方把「没输出」当成「没找到」）
 */
function run(command: string, args: string[]): string {
  try {
    return execFileSync(command, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
  }
  catch {
    return ''
  }
}

/**
 * 找出「正在监听某端口」的 PID。
 *
 * Windows 用 `netstat -ano`（`Get-NetTCPConnection` 是 PowerShell cmdlet，
 * 从 Node 里调它要再经过一层 shell，没有必要）；类 Unix 用 `lsof`。
 *
 * @param targetPort 目标端口
 * @returns 去重后的 PID
 */
function listeningPids(targetPort: number): number[] {
  const pids = new Set<number>()

  if (process.platform === 'win32') {
    for (const line of run('netstat', ['-ano', '-p', 'TCP']).split('\n')) {
      // 形如：  TCP    127.0.0.1:8787    0.0.0.0:0    LISTENING    9072
      const parts = line.trim().split(/\s+/)
      if (parts.length < 5 || parts[3] !== 'LISTENING')
        continue
      const local = parts[1]
      // 只比端口号：地址可能是 `127.0.0.1:8787` 或 `[::]:8787`
      if (local.slice(local.lastIndexOf(':') + 1) !== String(targetPort))
        continue
      const pid = Number.parseInt(parts[4], 10)
      if (Number.isFinite(pid) && pid > 0)
        pids.add(pid)
    }
    return [...pids]
  }

  const output = run('lsof', ['-ti', `tcp:${targetPort}`, '-sTCP:LISTEN'])
  for (const token of output.split('\n')) {
    const pid = Number.parseInt(token.trim(), 10)
    if (Number.isFinite(pid) && pid > 0)
      pids.add(pid)
  }
  return [...pids]
}

/**
 * 找出命令行里含 `imap-relay` 的进程 —— 就是中继自己。
 *
 * 这个补充是必要的：中继可能被别人用**另一个端口**起着（`pnpm relay --port 8788`），
 * 那种情况下它不监听默认端口，下次用默认端口启动其实没问题 —— 但它会继续
 * 占用资源、继续打印日志，容易让人以为「我关掉了」。
 *
 * @returns 去重后的 PID
 */
function relayPids(): number[] {
  const pids = new Set<number>()

  if (process.platform === 'win32') {
    const output = run('wmic', ['process', 'where', 'name=\'node.exe\'', 'get', 'ProcessId,CommandLine', '/format:csv'])
    for (const line of output.split('\n')) {
      if (!line.includes('imap-relay'))
        continue
      const match = /,(\d+)\s*$/.exec(line.trim())
      if (match)
        pids.add(Number.parseInt(match[1], 10))
    }
    return [...pids]
  }

  const output = run('ps', ['-eo', 'pid=,args='])
  for (const line of output.split('\n')) {
    if (!line.includes('imap-relay'))
      continue
    const pid = Number.parseInt(line.trim().split(/\s+/)[0], 10)
    if (Number.isFinite(pid) && pid > 0)
      pids.add(pid)
  }
  return [...pids]
}

/**
 * 入口。
 *
 * ⚠ 这里**刻意不用顶层 await**（虽然下面只等了一个 `setTimeout`）。
 *
 *   根 `package.json` 没有 `type: "module"`，所以 `.ts` 默认按 CommonJS 处理，
 *   而 esno（esbuild）在 CJS 输出格式下会直接报
 *   「Top-level await is currently not supported with the cjs output format」，
 *   `tsc` 那边也会报 TS1378。
 *
 *   把逻辑包进 `main()` 是**最小**的修法：既不用给根 `package.json` 加
 *   `type: "module"`（那会波及整个仓库的模块解析，包括 vite 配置与打包产物），
 *   也不用给 `scripts/` 单独塞一个 `package.json`（那是个只有内行才看得懂的隐含约定）。
 */
async function main(): Promise<void> {
  const port = Number.parseInt(process.argv[2] ?? process.env.PORT ?? '8787', 10)

  if (!Number.isFinite(port) || port <= 0) {
    console.error(`端口无效：${process.argv[2]}`)
    process.exit(1)
  }

  const targets = new Set([...listeningPids(port), ...relayPids()])
  targets.delete(process.pid)

  if (!targets.size) {
    console.log(`✅ 端口 ${port} 没有被占用，也没有残留的中继进程`)
    process.exit(0)
  }

  for (const pid of targets) {
    if (process.platform === 'win32')
      run('taskkill', ['/PID', String(pid), '/F'])
    else
      run('kill', ['-9', String(pid)])
    console.log(`已停止 PID ${pid}`)
  }

  // 复查：给内核一点时间回收监听套接字
  await new Promise(resolve => setTimeout(resolve, 500))

  const still = listeningPids(port)
  if (still.length) {
    console.error(`⚠️  端口 ${port} 仍被占用（PID ${still.join(', ')}）—— 可能需要管理员权限`)
    process.exit(1)
  }

  console.log(`✅ 端口 ${port} 已释放`)
}

void main()
