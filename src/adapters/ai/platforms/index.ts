import type { AiProvider, AiProviderConfig } from '../types'
import type { AiPlatformDefinition } from './types'
import { collectAdapters } from '../../collect'

/**
 * AI 平台注册表 + 工厂。
 *
 * **新增一家平台 = 加一个 `platforms/<id>/` 目录（`index.ts` 里默认导出
 * `defineAiPlatform(...)`），然后什么都不用改** —— 本文件按目录约定 glob 它们，
 * Options 的下拉框也从这里读。
 */

const DEFAULT_MAX_TOKENS = 2048

/** 全部平台声明，按目录路径排序（顺序即 Options 下拉框的展示顺序） */
export const AI_PLATFORMS: AiPlatformDefinition[] = collectAdapters(
  import.meta.glob<{ default: AiPlatformDefinition }>('./*/index.ts', { eager: true }),
).filter(platform => !!platform?.id)

/** 按 id 取平台声明；未知 id 返回 undefined */
export function getAiPlatform(id: string): AiPlatformDefinition | undefined {
  return AI_PLATFORMS.find(platform => platform.id === id)
}

/**
 * 平台工厂：按 id 选定声明，并用用户配置覆盖默认地址 / 模型。
 *
 * ⚠ 未知 id **抛错**而不是回退到第一个平台：存储里可能残留已废弃的平台名，
 *   静默回退会让用户以为「AI 还能用」，而实际上他的 Key 发去了另一家。
 */
export function createAiProvider(id: string, config: AiProviderConfig): AiProvider {
  const platform = getAiPlatform(id)
  if (!platform) {
    throw new Error(`未知的 AI 平台：${id}（可用：${AI_PLATFORMS.map(item => item.id).join(' / ')}）`)
  }

  const baseUrl = config.baseUrl || platform.defaultBaseUrl
  const model = config.model || platform.defaultModel

  if (!baseUrl)
    throw new Error(`AI 平台「${platform.label}」还没有配置接口地址（Base URL）`)
  if (!model)
    throw new Error(`AI 平台「${platform.label}」还没有配置模型名（Model）`)

  return {
    id: platform.id,
    name: platform.providerName,
    protocol: platform.protocol,
    capabilities: platform.capabilities,
    config: {
      baseUrl,
      apiKey: config.apiKey,
      model,
      maxTokens: config.maxTokens ?? DEFAULT_MAX_TOKENS,
      thinking: config.thinking ?? false,
      thinkingToggle: platform.thinkingToggle,
    },
  }
}

/**
 * 一个平台**过消息通道**之后的样子（Options 的 AI 配置页读它）。
 *
 * 与 `AiPlatformDefinition` 的差别都是刻意的：
 *   - `id` → `value`（跟其它下拉一致）；
 *   - `capabilities.nativeJson` → 摊平成 `nativeJson`（界面只关心这一项能力）；
 *   - `protocol` / `providerName` / `capabilities` 本身不过通道（见下面的排除表）。
 */
export interface AiPlatformOptionPayload {
  value: string
  label: string
  hint: string
  /** 接口地址留空时实际会用的地址，设置页直接显示它，省得用户去翻文档 */
  defaultBaseUrl: string
  defaultModel: string
  nativeJson: boolean
  /**
   * 这个平台有没有「思考模式」。
   *
   * ⚠ 界面**必须**拿它来决定要不要显示那个勾选框：协议层只在它为真时才发
   *   关闭思考的参数。少了它，OpenAI / Anthropic 上会出现一个勾了没用的开关。
   */
  thinkingToggle: boolean
}

/**
 * `AiPlatformDefinition` 里**故意不**过消息通道的字段。
 *
 * 单测会拿它和 `AI_PLATFORM_OPTIONS` 能覆盖的字段对账：源定义里出现新字段而
 * 两处都没提到时测试失败。加字段时只有两个选择 —— 放进载荷，或者放进这里并写清理由。
 */
export const AI_PLATFORM_OPTION_EXCLUDED = new Set<keyof AiPlatformDefinition>([
  // wire 格式处理器：对象里带函数，结构化克隆过不去；它只在 background 侧用
  'protocol',
  // 只有 `nativeJson` 是界面需要的，其余（如 `maxInputChars`）是 prompt 组装侧的事
  'capabilities',
  // 只在连通性测试的结果文案里用（background 侧拼好再给界面），界面不需要自己判断
  'providerName',
])

/** 供 Options 展示的可选平台清单（顺序即展示顺序） */
export const AI_PLATFORM_OPTIONS: AiPlatformOptionPayload[] = AI_PLATFORMS.map(platform => ({
  value: platform.id,
  label: platform.label,
  hint: platform.hint,
  defaultBaseUrl: platform.defaultBaseUrl,
  defaultModel: platform.defaultModel,
  nativeJson: platform.capabilities.nativeJson,
  thinkingToggle: platform.thinkingToggle,
}))

export type { AiProvider, AiProviderCapabilities, AiProviderConfig } from '../types'
export type { AiPlatformDefinition } from './types'
export { defineAiPlatform } from './types'
