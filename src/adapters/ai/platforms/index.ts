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

/** 供 Options 展示的可选平台清单（顺序即展示顺序） */
export const AI_PLATFORM_OPTIONS = AI_PLATFORMS.map(platform => ({
  value: platform.id,
  label: platform.label,
  hint: platform.hint,
  /** 接口地址留空时实际会用的地址，设置页直接显示它，省得用户去翻文档 */
  defaultBaseUrl: platform.defaultBaseUrl,
  defaultModel: platform.defaultModel,
  nativeJson: platform.capabilities.nativeJson,
}))

export type { AiProvider, AiProviderCapabilities, AiProviderConfig } from '../types'
export type { AiPlatformDefinition } from './types'
export { defineAiPlatform } from './types'
