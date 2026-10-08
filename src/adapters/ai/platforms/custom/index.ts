import { createOpenAIProtocol } from '../../protocols/openai'
import { defineAiPlatform } from '../types'

/**
 * 自定义（任何 OpenAI 兼容的中转 / 自建服务）。
 *
 * 用户**必须**填 baseUrl 与 model —— 这里给的默认值是故意的占位：
 * 留空的话用户点「测试连通」会打到一个不存在的地址，而报错会说「网络请求失败」，
 * 完全指不到「你还没填地址」这件事上。
 *
 * `nativeJson: true` 是**乐观假设**：绝大多数中转站透传 `response_format`。
 * 若目标服务不认这个字段，它的表现通常是忽略（而不是报错），所以走这条路
 * 不会更糟；但若用户遇到「回的不是 JSON」，把提示词里的 JSON 要求写得更死即可
 * （`prompt-build.ts` 本来就会拼 schema 描述）。
 */
export default defineAiPlatform({
  id: 'custom',
  providerName: '自定义',
  protocol: createOpenAIProtocol(),
  defaultBaseUrl: '',
  defaultModel: '',
  capabilities: { nativeJson: true, maxInputChars: 60_000 },
  thinkingToggle: true,
  label: '自定义（OpenAI 兼容）',
  hint: '任何兼容 /chat/completions 的服务；必须自己填 Base URL 与模型名',
})
