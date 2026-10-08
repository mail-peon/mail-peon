/**
 * AI 协议层类型：定义 wire 格式（请求体 / 响应体长什么样）。
 *
 * 分三层（**protocol → platform → factory**），镜像 `offer-hunter/src/adapters/ai/`：
 *
 *   protocol  只关心 wire 格式（OpenAI `/chat/completions`、Anthropic `/v1/messages`）
 *   platform  声明式预设：选定协议 + 声明能力 + 默认地址/模型
 *   factory   按平台 id 用用户配置覆盖默认值，造出 `AiProvider`
 *
 * 默认地址 / 默认模型 / 超时这类「每个平台一份的常量」全部收敛在平台声明里，
 * 协议层不再各自重复声明一份（重复的那份从来没人读）。
 */

export type ChatRole = 'system' | 'user' | 'assistant'

export interface ChatMessage {
  role: ChatRole
  content: string
}

export interface ChatRequest {
  system: string
  messages: ChatMessage[]
  /** 要求模型只输出 JSON */
  json?: boolean
}

/** 各协议统一返回纯文本内容；JSON 解析交给上层，错误信息带上下文更易排查 */
export interface ChatResponse {
  text: string
  raw: unknown
}

export interface PingResult {
  ok: boolean
  /** 成功时返回模型的回显文本，用于确认模型确实可用 */
  reply?: string
  error?: string
  /** 往返耗时（毫秒） */
  latencyMs?: number
}

export interface AiProtocol {
  readonly name: string
  chat: (req: ChatRequest, config: ResolvedConfig) => Promise<ChatResponse>
  /**
   * 最小连通性探测：发一个极短的请求，验证地址 / Key / 模型名三者都对。
   *
   * 刻意不复用 `chat()`：chat 会带上完整的 system + messages 与业务参数，
   * 任何一个配置错误都会混在一起难以定位；探测要的是「网络与鉴权是否通」。
   */
  ping: (config: ResolvedConfig) => Promise<PingResult>
}

/** 用户在 Options 里填的那部分配置 */
export interface AiProviderConfig {
  baseUrl?: string
  apiKey: string
  model?: string
  maxTokens?: number
  thinking?: boolean
}

/** 平台默认值补齐之后的最终配置（协议层只认这个） */
export interface ResolvedConfig {
  baseUrl: string
  apiKey: string
  model: string
  maxTokens: number
  thinking: boolean
  /**
   * 是否允许发送「关闭思考」的参数。
   *
   * 只有确实存在思考模式的平台才该发：Anthropic 官方 API 上 `reasoning` 仅对
   * 3.7+ 模型有效，对老模型发送会直接报错。
   */
  thinkingToggle: boolean
}

/**
 * 平台能力声明。上层（`summarize.ts` / `prompt-build.ts`）只读这些能力来决定策略，
 * 不关心底下是哪家。
 */
export interface AiProviderCapabilities {
  /**
   * 这家平台能不能**原生要求 JSON 输出**。
   *
   * ⚠ 刻意是布尔而不是「用了哪种机制」的枚举：`json_object`（OpenAI / DeepSeek）与
   *   「靠 prompt 约束」是**有 / 没有**这种能力的两类，而不是并列的两种机制。
   *   选哪种机制是**各协议自己的事** —— 契约只回答「有没有」。
   */
  nativeJson: boolean
  /**
   * 单次请求可接受的最大输入字符数。
   *
   * 必须被真正使用（见 `logic/ai/prompt-build.ts` 的截断）：一封长邮件原样拼接
   * 会直接撞上下文上限，而撞上限的表现是「AI 莫名其妙回不出东西」。
   */
  maxInputChars: number
}

export interface AiProvider {
  /** 平台 id（写进日志与测试结果，让用户确认实际用的是哪家） */
  readonly id: string
  /** 展示名 */
  readonly name: string
  readonly protocol: AiProtocol
  readonly capabilities: AiProviderCapabilities
  readonly config: ResolvedConfig
}
