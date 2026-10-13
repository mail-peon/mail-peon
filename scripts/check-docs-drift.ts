/**
 * 「文档漂移」检查 —— 在 CI 里跑，命中就红。
 *
 * ## 干什么的
 *
 * 跨仓库手动对齐文档时会漏：旧端口值 / 旧产品名 / 旧文案。
 * 这份脚本 grep 一份「已知过期字符串」清单，命中即失败。
 *
 * ## 为什么不用现成的 `markdown-link-check` / `textlint`
 *
 * 那两个工具查的是「链接是否还活着 / 拼写错没错」；这里查的是「这条字符串
 * 是不是已经过期、但写文档的人忘了同步」。定制化更直接。
 *
 * ## 怎么加新规则
 *
 * 在 `STALE_STRINGS` 里加 `{ pattern, reason, since }`：`pattern` 是要查的**字面量**
 * （走 `String.includes`，不是正则 —— 过期字符串都是具体的值，正则只会让
 * 「到底在查什么」变得难读，真要正则再加也不迟），`reason` 是一条人话原因，
 * `since` 是当初删除这条字符串的版本（找 `git log -S`）。
 *
 * ⚠ 规则表**逐字**写着那些过期字符串，所以脚本必须跳过自己（见 `SELF`），
 *   否则每加一条规则就自命中一次。
 *
 * ## 怎么「豁免」
 *
 * 设计文档解释「为什么这个旧值被淘汰」是合理的（比如 `port-and-discovery.md`
 * § 2 解释为什么淘汰旧端口）—— 这种情况下用注释行 `// allow-historical: <reason>`
 * 标在该行末尾。
 *
 * ## 跑法
 *
 * ```bash
 * pnpm run drift                              # 整库扫（CI 走这条）
 * esno scripts/check-docs-drift.ts path/...   # 只扫指定路径
 * ```
 *
 * ## 退出码
 *
 * - `0`：没找到过期
 * - `1`：找到至少一处
 * - `2`：脚本本身报错
 */

import type { Dirent } from 'node:fs'
import { readdir, readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

/** 一条「已知过期字符串」规则。 */
interface DriftRule {
  /** 要查的字面量（`String.includes`）。 */
  pattern: string
  /** 为什么这个字符串已经不该出现。 */
  reason: string
  /** 当初删除这条字符串的版本（找 `git log -S`）。 */
  since: string
}

/** 一处命中。 */
interface DriftFinding {
  file: string
  line: number
  pattern: string
  reason: string
  since: string
  /** 命中那一行的原文（裁剪过），给人看上下文用。 */
  text: string
}

/** 已知过期字符串 —— 命中就报错。 */
const STALE_STRINGS: DriftRule[] = [
  {
    // 现状：mail-peon 默认端口已经从 8787 切换到 41316（组 4 改的）。
    // 命中含义：有人写文档/代码时把旧端口当默认值。
    pattern: 'ws://127.0.0.1:8787',
    reason: 'mail-peon 默认端口已切换到 41316（`docs/privacy-policy.md` / `src/adapters/mail/providers/imap/index.ts`）。这条出现意味着忘同步了。',
    since: '组 4（2026-10）',
  },
  {
    // 现状：TS 中继脚本 `scripts/imap-relay.ts` 的默认端口也切换到 41316。
    // 命中含义：UI 提示 / 测试字面量 / 文档还是旧端口。
    pattern: '\'8787\'',
    reason: '`scripts/imap-relay.ts` 默认端口 41316。字符串字面量 \'8787\' 仍出现意味着忘同步。',
    since: '组 4（2026-10）',
  },
  {
    // 现状：burrow README 顶部的「文档先行 / 代码未开始」段已更新为「实现到 S13」。
    pattern: '代码未开始',
    reason: 'peon-burrow README 与 ai-docs/README 已更新为「实现到 S13，S14 待办」。',
    since: '组 1（2026-10）',
  },
  {
    // 现状：服务模式日志按大小滚动已经接上（run.rs:96-101 → RotatingWriter）。
    pattern: 'log_max_mib / log_keep_files 还没接上',
    reason: 'peon-burrow 服务模式日志按大小滚动已实现（`crates/peon-burrow/src/logging.rs` + 4 单测）。',
    since: '组 7（2026-10）',
  },
]

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)))

/**
 * 本脚本自身的绝对路径 —— 扫描时要跳过它。
 *
 * ⚠ 不跳的话这个检查**永远红**：`STALE_STRINGS` 表里是**逐字**写着那些过期字符串的
 *   （`pattern: 'ws://127.0.0.1:8787'` 这行本身就含 `ws://127.0.0.1:8787`），
 *   于是每加一条规则就自命中一次 —— 看起来像文档漂移，其实是规则表在照镜子。
 *
 *   代价是 `release.yaml` 的 Docs drift check 这一步在修好之前**不可能通过**，
 *   而它又排在打包之前，等于整条发版链路被一个假阳性堵死。
 *
 * ⚠ 两边都用 `fileURLToPath` 而不是 `URL.pathname`：后者的路径里带百分号转义
 *   （路径含空格时是 `%20`），而 `readdir` 给的是真空格 —— 一比就不相等，
 *   跳过失效、检查又红了，且只在「仓库路径带空格」的机器上复现。
 *
 * ⚠ 本文件是 `.ts`（不是 `.mts`），所以 esno 按 CJS 跑它 —— `import.meta.url`
 *   由 tsx 垫好（实测可用）。代价是不能用顶层 await（CJS 输出不支持），
 *   入口写成 `main().catch(...)`，与 `scripts/relay-kill.ts` 同一个理由。
 */
const SELF = fileURLToPath(import.meta.url)

/** 扫一个文件，返回其中所有命中。 */
function scanFile(filePath: string, text: string): DriftFinding[] {
  const lines = text.split(/\r?\n/)
  const findings: DriftFinding[] = []
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]
    /*
     * 豁免：行尾带 `// allow-historical: <reason>`。
     *
     * ⚠ 判据是 `includes` 而不是 `endsWith` —— 注释的约定写法是
     *   `...  // allow-historical: 为什么保留`，**行尾是原因、不是标记本身**。
     *   用 `endsWith('allow-historical:')` 的话这个豁免一次也不会生效，
     *   等于文档里写着一条不存在的逃生口。
     */
    if (line.includes('allow-historical:')) {
      continue
    }
    for (const rule of STALE_STRINGS) {
      if (line.includes(rule.pattern)) {
        findings.push({
          file: filePath,
          line: i + 1,
          pattern: rule.pattern,
          reason: rule.reason,
          since: rule.since,
          text: line.trim(),
        })
      }
    }
  }
  return findings
}

const SKIP_DIRS = new Set([
  'node_modules',
  'dist',
  'extension',
  'target',
  '.git',
  '.vite-temp',
  '.vite',
  'src-tauri/target',
  'src-tauri/binaries',
])

/**
 * 收集要扫的文件清单。
 *
 * 默认扫**整个仓库**（`src/` / `ai-docs/` / `docs/` / `scripts/` / `.github/` /
 * `README.md` / `package.json` …）—— 过期字符串会出现在任何写到它的地方，
 * 只扫文档目录会让「代码里还留着旧端口」这种最该抓的情况漏掉。
 *
 * 跳过的只有两处：`SKIP_DIRS`（构建产物与依赖）和**脚本自己**（`SELF`，见它的说明）。
 */
async function* walkFiles(roots: string[]): AsyncGenerator<string> {
  for (const root of roots) {
    yield* walkDir(root)
  }
}

async function* walkDir(dir: string): AsyncGenerator<string> {
  let entries: Dirent[]
  try {
    entries = await readdir(dir, { withFileTypes: true })
  }
  catch {
    return
  }
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name))
        continue
      yield* walkDir(`${dir}/${entry.name}`)
    }
    else {
      // 只扫文本类扩展名；二进制 / 图片 / 锁文件 / .tsbuildinfo 等会超时
      if (!/\.(?:ts|mts|mjs|cjs|js|vue|md|mdx|toml|json|yaml|yml|css|html)$/i.test(entry.name))
        continue
      // 规则表自己 —— 扫它必然命中（见 `SELF`），那是数据不是漂移
      if (resolve(dir, entry.name) === SELF)
        continue
      yield `${dir}/${entry.name}`
    }
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2)
  const roots = args.length > 0 ? args : [ROOT]
  const findings: DriftFinding[] = []
  for await (const file of walkFiles(roots)) {
    const text = await readFile(file, 'utf8')
    findings.push(...scanFile(file, text))
  }
  if (findings.length === 0) {
    console.log('✅ 文档没找到已知过期字符串（docs-drift-check 通过）')
    process.exit(0)
  }
  console.error(`✗ 文档漂移：找到 ${findings.length} 处已知过期字符串\n`)
  for (const finding of findings) {
    const relPath = finding.file.replace(ROOT, '.')
    console.error(`  ${relPath}:${finding.line}`)
    console.error(`    命中：  ${finding.pattern}`)
    console.error(`    上下文：${finding.text}`)
    console.error(`    原因：  ${finding.reason}`)
    console.error(`    自：    ${finding.since}`)
    console.error('')
  }
  process.exit(1)
}

main().catch((error: unknown) => {
  console.error('docs-drift-check 自身报错：', error)
  process.exit(2)
})
