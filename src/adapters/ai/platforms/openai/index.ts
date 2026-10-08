import { createOpenAIProtocol } from '../../protocols/openai'
import { defineAiPlatform } from '../types'

/**
 * OpenAI：原生 JSON 输出（`response_format: json_object`）。
 *
 * 默认用 `gpt-4o-mini`：本项目单封邮件的输入（subject + 前 6000 字正文）通常在
 * 3k token 以内、输出 200 token 以内，这个档次完全够用，而价格是旗舰模型的
 * 十分之一 —— 邮件是**长期高频**的调用，档位选贵了用户会关掉它。
 */
export default defineAiPlatform({
  id: 'openai',
  providerName: 'OpenAI',
  protocol: createOpenAIProtocol(),
  defaultBaseUrl: 'https://api.openai.com/v1',
  defaultModel: 'gpt-4o-mini',
  capabilities: { nativeJson: true, maxInputChars: 60_000 },
  // 没有需要显式关闭的思考模式参数
  thinkingToggle: false,
  label: 'OpenAI',
  hint: '原生 JSON 输出；需要能访问 api.openai.com',
})
