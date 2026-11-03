import type { AiResult } from './schema'
import type { Mail, MailTypeAdapter, MailTypeMatch } from '~/logic/types'
import { formatSender } from '~/adapters/mail/parser'
import { MailStateFlag } from '~/logic/types'
import { heuristicCode, heuristicIsAd } from './heuristics'
import { deriveAiOutput } from './resolve'
// ---------------------------------------------------------------------------
// 降级
// ---------------------------------------------------------------------------

/**
 * 降级结果（`features/02-ai-summary.md § 5`）。
 *
 * 设计原则：**AI 挂了也要能看到邮件**。所以降级不是「空记录 + 错误」，
 * 而是「用启发式规则尽力填一份 + 标记 degraded」。
 *
 * - 验证码：`heuristicCode` 启发式提取（仅当 code 适配器启用）；
 * - 总结：仅当 summary 适配器启用时，用邮件基础信息 + snippet 拼一份；
 * - states：有 `List-Unsubscribe` ⇒ Ad。
 */
export function fallbackResult(
  mail: Mail,
  adapters: MailTypeAdapter[],
  error: string,
): AiResult {
  const enabled = adapters.filter(adapter => adapter.enabled)
  const types: MailTypeMatch[] = []

  const codeAdapter = enabled.find(adapter => adapter.ui === 'code')
  if (codeAdapter) {
    const code = heuristicCode(mail)
    if (code) {
      types.push({
        kind: 'code',
        adapterId: codeAdapter.id,
        adapterName: codeAdapter.name,
        code,
      })
    }
  }

  const summaryAdapter = enabled.find(adapter => adapter.ui === 'summary')
  // 降级路径同样遵守兜底规则：验证码命中时不再生成总结
  if (summaryAdapter && !types.some(match => match.kind === 'code')) {
    types.push({
      kind: 'summary',
      adapterId: summaryAdapter.id,
      adapterName: summaryAdapter.name,
      minimal: buildFallbackMinimal(mail),
      text: buildFallbackSummary(mail, error),
    })
  }

  const output = deriveAiOutput(types)
  output.degraded = true
  output.error = error

  return {
    output,
    stateFlags: heuristicIsAd(mail) ? MailStateFlag.Ad : MailStateFlag.None,
  }
}

export function buildFallbackMinimal(mail: Mail): string {
  const sender = formatSender(mail.from)
  const subject = mail.subject.trim()
  return (subject ? `${sender}：${subject.slice(0, 30)}` : sender).slice(0, 200)
}

export function buildFallbackSummary(mail: Mail, error: string): string {
  const lines = [
    `- 发件人：${formatSender(mail.from)}`,
    `- 主题：${mail.subject || '(无主题)'}`,
    `- 时间：${new Date(mail.receivedAt).toLocaleString('zh-CN')}`,
  ]

  const preview = (mail.snippet || mail.bodyText || '').trim()
  if (preview)
    lines.push('', preview.slice(0, 400))

  lines.push('', `> ⚠️ AI 处理失败，以上为邮件基础信息。原因：${error}`)
  return lines.join('\n')
}
