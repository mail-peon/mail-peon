import { createOpenAIProtocol } from '../../protocols/openai'
import { defineAiPlatform } from '../types'

/**
 * DeepSeek：OpenAI 兼容 wire 格式。
 *
 * ⚠ 自 V4 起**思考模式默认开启**（effort 默认 high）。思考内容会先消耗 token 预算，
 *   导致 `content` 为空、答案只在 `reasoning_content` 里 —— 这正是「连接测试正常
 *   但回显空」「报模型返回了空内容」的根因。本项目场景（验证码提取、邮件摘要）
 *   都是短输出，思考带来的收益远不及「输出为空」的代价，因此 `thinkingToggle: true`
 *   且默认关闭。
 *
 * ⚠ 模型名随版本变动，务必以官方文档为准：
 *   - 当前：`deepseek-chat` / `deepseek-reasoner`
 *   - 若报「模型不存在」，去设置页把模型名改成控制台上列出的那个
 */
export default defineAiPlatform({
  id: 'deepseek',
  providerName: 'DeepSeek',
  protocol: createOpenAIProtocol(),
  defaultBaseUrl: 'https://api.deepseek.com/v1',
  defaultModel: 'deepseek-chat',
  capabilities: { nativeJson: true, maxInputChars: 60_000 },
  thinkingToggle: true,
  label: 'DeepSeek',
  hint: '中文好、价格低；默认已关闭思考模式（开着会导致输出为空）',
})
