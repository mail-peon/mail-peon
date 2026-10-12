#!/usr/bin/env node
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
 * - **字符串匹配**：在 `STALE_STRINGS` 里加 `{ pattern, reason, since }`。
 *   `pattern` 是要查的字面量；`reason` 是一条人话原因；
 *   `since` 是当初删除这条字符串的版本（找 `git log -S`）。
 *
 * - **正则匹配**：传 `pattern: /.../` 形态。**慎用**，跨多语言正则难调试；
 *   优先用「字面」+ 多个独立条目。
 *
 * ## 怎么「豁免」
 *
 * 设计文档解释「为什么这个旧值被淘汰」是合理的（比如 `port-and-discovery.md`
 * § 2 解释为什么不用 8787）—— 这种情况下用注释行 `// allow-historical: <reason>`
 * 标在该行末尾。
 *
 * ## 跑法
 *
 * ```bash
 * node scripts/check-docs-drift.mjs           # 整库扫
 * node scripts/check-docs-drift.mjs path/...   # 扫指定路径
 * ```
 *
 * ## 退出码
 *
 * - `0`：没找到过期
 * - `1`：找到至少一处
 * - `2`：脚本本身报错
 */

import { readdir, readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import process from 'node:process'

/** 已知过期字符串 —— 命中就报错。 */
const STALE_STRINGS = [
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

const ROOT = resolve(new URL('..', import.meta.url).pathname)

/**
 * 扫一个文件，命中记一条 include `old_string` 在文档里的绝对行号。
 *
 * @param {string} filePath
 * @param {string} text
 */
function scanFile(filePath, text) {
  const lines = text.split(/\r?\n/)
  const findings = []
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]
    // 豁免：行尾带 `// allow-historical: <reason>`
    if (line.trimEnd().endsWith('allow-historical:')) {
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
 * 只扫仓库里**真实有改动的**那几类：src/、ai-docs/、scripts/、docs/、README.md。
 * 不递归 node_modules / extension/dist / .vite-cache 等。
 *
 * @param {string[]} roots
 */
async function* walkFiles(roots) {
  for (const root of roots) {
    yield* walkDir(root)
  }
}

async function* walkDir(dir) {
  let entries
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
      if (!/\.(?:ts|mjs|cjs|js|vue|md|mdx|toml|json|yaml|yml|css|html)$/i.test(entry.name))
        continue
      yield `${dir}/${entry.name}`
    }
  }
}

async function main() {
  const args = process.argv.slice(2)
  const roots = args.length > 0 ? args : [ROOT]
  const findings = []
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

main().catch((error) => {
  console.error('docs-drift-check 自身报错：', error)
  process.exit(2)
})
