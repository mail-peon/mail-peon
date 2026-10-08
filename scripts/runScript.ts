import type { SpawnOptions } from 'node:child_process'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import process from 'node:process'

/**
 * 用 **esno** 跑一个 TypeScript 脚本（含子进程场景）。
 *
 * ## 为什么需要这个文件
 *
 * `pnpm relay` 这类命令直接在 shell 里写 `esno scripts/imap-relay.ts` 就够了。
 * 但**测试**要自己把中继当子进程拉起来（要抓它的 stdout、要造真 TTY），
 * 那时 `process.execPath` + 脚本路径是不够的 —— Node 不会自己认 `.ts`。
 *
 * 试过并**否定**的两条路，记在这里免得以后有人再踩：
 *
 *   - `node --import esno/register` → esno 的 `package.json` 没有 `exports` 字段，
 *     只暴露了 `bin`，所以这个子路径解析不到（`ERR_MODULE_NOT_FOUND`）；
 *   - `node --import tsx` → 同理。esno 4.x 内部**依赖** tsx，但没把它的 loader
 *     入口作为子路径导出，所以从外面拿不到。
 *
 * ## 采用的办法
 *
 * 直接执行 **esno 自己的 bin 文件**：`node <...>/esno/esno.js <script.ts> …`。
 *
 *   - 不需要 `shell: true` —— 这一点在 Windows 上很重要：
 *     `shell: true` 会让参数经过一次字符串拼接，带空格/引号的路径会被拆错，
 *     而且多套一层 `cmd.exe` 会让子进程树里多一个「看起来像中继的」进程
 *     （`relay-kill` 按命令行匹配杀进程时会被它干扰）。
 *   - 用 `createRequire` 解析而不是硬编码 `node_modules/esno/esno.js`：
 *     pnpm 的布局可能是提升的、也可能在 `.pnpm` 里，硬编码会在其中一种下失败。
 */

const require = createRequire(import.meta.url)

/**
 * esno 的 bin 入口绝对路径。
 *
 * ⚠ 解析失败时**立刻抛错**并给出可操作的提示，而不是偷偷退化成别的方式 ——
 *   「测试跑起来了但跑的是别的东西」比「测试跑不起来」难查得多。
 */
function resolveEsnoBin(): string {
  try {
    // `esno/package.json` 有 `bin: { esno: 'esno.js' }`，用它定位同目录下的入口
    const pkgPath = require.resolve('esno/package.json')
    return pkgPath.replace(/package\.json$/, 'esno.js')
  }
  catch {
    throw new Error(
      '找不到 esno。请先执行 `pnpm install`（esno 在 devDependencies 里，'
      + '而中继脚本是 TypeScript，必须由它来跑）。',
    )
  }
}

/** esno bin 的绝对路径（每次调用都解析 `package.json`，开销可忽略） */
export function esnoBin(): string {
  return resolveEsnoBin()
}

/**
 * 以子进程方式跑一个 TS 脚本。
 *
 * @param script 脚本路径（相对仓库根目录，例如 `scripts/imap-relay.ts`）
 * @param args 传给脚本的参数
 * @param options `spawn` 的选项（`stdio` / `env` / `cwd` …）
 * @returns 子进程句柄
 */
export function spawnScript(script: string, args: string[] = [], options: SpawnOptions = {}) {
  return spawn(process.execPath, [resolveEsnoBin(), script, ...args], options)
}
