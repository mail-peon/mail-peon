import type { AiProtocol, AiProviderCapabilities } from '../types'

/**
 * 一个 AI 平台的**声明**。
 *
 * 每个平台一个目录 + 一个 `index.ts`，注册表（`platforms/index.ts`）按目录约定
 * glob 它们。加一家平台**不需要改注册表**，也不需要改设置页 —— 设置页读的就是
 * 这张声明表。
 */
export interface AiPlatformDefinition {
  /**
   * 平台标识，必须与 `src/adapters/ai/platforms/<id>/` 目录名一致
   * （设置页按它存 `AiSettings.platform`；改了会让用户的配置指向一个不存在的平台）。
   */
  id: string
  /** 写进连通性测试结果里，让用户确认实际用的是哪家 */
  providerName: string
  /** wire 格式处理器（各平台自己建一个；它们是无状态的，一份实例可以共用） */
  protocol: AiProtocol
  /** 接口地址留空时用的地址 */
  defaultBaseUrl: string
  /** 模型名留空时用的模型 */
  defaultModel: string
  capabilities: AiProviderCapabilities
  /**
   * 是否发送「关闭思考」参数。
   *
   * 只有确实存在思考模式的平台才该发（见各平台声明里的说明）。
   */
  thinkingToggle: boolean
  /** 设置页展示用 */
  label: string
  hint: string
}

/**
 * 声明一个 AI 平台。
 *
 * 运行时不做任何加工，只给类型与写法一个统一落点：每个平台目录的 `index.ts`
 * 都写成 `export default defineAiPlatform({ … })`，注册表据此按目录约定 glob。
 */
export function defineAiPlatform(platform: AiPlatformDefinition): AiPlatformDefinition {
  return platform
}
