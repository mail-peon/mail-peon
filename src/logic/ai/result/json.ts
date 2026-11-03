/**
 * 容错解析模型返回的 JSON。
 *
 * 模型经常在 JSON 外面包一层 ```json 代码块，或前后带解释性文字 ——
 * 即使提示词明确说了「不要」，这件事依然会发生（各家模型的遵循度不同）。
 *
 * ⚠ 刻意不用正则剥代码块：`/```(?:json)?\s*([\s\S]*?)```/` 有回溯风险，
 *   而这里处理的正是**不可信输入**（模型输出），不能给它留 ReDoS 的口子。
 */
export function parseJsonLoose(text: string): unknown {
  const trimmed = text.trim()
  if (!trimmed)
    throw new Error('模型返回了空内容')

  try {
    return JSON.parse(trimmed)
  }
  catch {
    // 继续尝试剥离
  }

  // ```json ... ```
  if (trimmed.startsWith('```')) {
    const firstNewline = trimmed.indexOf('\n')
    const fenceEnd = trimmed.indexOf('```', 3)
    if (firstNewline !== -1 && fenceEnd > firstNewline) {
      try {
        return JSON.parse(trimmed.slice(firstNewline + 1, fenceEnd).trim())
      }
      catch {
        // 继续尝试
      }
    }
  }

  // 截取第一个 { 到最后一个 }
  const start = trimmed.indexOf('{')
  const end = trimmed.lastIndexOf('}')
  if (start !== -1 && end > start) {
    try {
      return JSON.parse(trimmed.slice(start, end + 1))
    }
    catch {
      // 落到下面抛错
    }
  }

  throw new Error(`无法从模型返回中解析出 JSON：${trimmed.slice(0, 200)}`)
}
