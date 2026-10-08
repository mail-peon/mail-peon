import { createAnthropicProtocol } from '../../protocols/anthropic'
import { defineAiPlatform } from '../types'

/**
 * Anthropic。
 *
 * ⚠ **没有原生 JSON 输出**：`/v1/messages` 不支持 `response_format`，只能靠
 *   system prompt 里明确写「只返回合法 JSON」来约束（`prompt-build.ts` 会保证
 *   那些字样存在）。所以 `nativeJson: false`，上层会走「prompt 约束 + 容错解析」
 *   那条路 —— 这也是为什么 AI 输出必须过 zod 校验。
 *
 * `thinkingToggle: false`：官方 API 上 `reasoning` 只对 3.7+ 模型有效，
 * 对老模型发送会直接报错。与其赌用户的模型版本，不如不发。
 */
export default defineAiPlatform({
  id: 'anthropic',
  providerName: 'Anthropic',
  protocol: createAnthropicProtocol(),
  defaultBaseUrl: 'https://api.anthropic.com',
  defaultModel: 'claude-3-5-haiku-latest',
  capabilities: { nativeJson: false, maxInputChars: 60_000 },
  thinkingToggle: false,
  label: 'Anthropic',
  hint: '不支持原生 JSON 输出，靠提示词约束；长邮件理解力好',
})
