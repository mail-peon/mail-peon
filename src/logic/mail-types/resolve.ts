import type { BuiltinAdapterDef } from './catalog'
import type { MailTypeAdapter, MailTypeRecord } from '~/logic/types'
import { t } from '~/logic/strings'
import { BUILTIN_CODE_ID, BUILTIN_SUMMARY_ID } from '~/logic/types'
import { BUILTIN_ADAPTERS, MINIMAL_MODE_ADAPTER_IDS } from './catalog'

/**
 * 把「内置 catalog + 用户 override + 自定义记录」合并成运行时视图。
 *
 * ## 模式是**生效层 overlay**，不是写操作
 *
 * 极简模式强制只生效「验证码 + 确认」，其余全部关闭 —— 但**不修改**保存的
 * override / 自定义记录。这样用户切到极简看一眼再切回自定义时，之前配的开关还在。
 *
 * ## 排序
 *
 * 内置固定：验证码(10) → 确认(20) → 总结(999)。
 * 自定义默认从 100 开始（落在确认之后、总结之前）；用户上下移 = 改 priority。
 */

export type PromptLang = 'zh' | 'en'

export interface ResolveAdaptersOptions {
  minimalMode: boolean
  /** 与基础 system prompt 的语言保持一致 */
  lang: PromptLang
}

function builtinName(def: BuiltinAdapterDef): string {
  return t(def.nameKey)
}

function builtinDescription(def: BuiltinAdapterDef): string {
  return t(def.descriptionKey)
}

export function resolveMailTypeAdapters(
  records: MailTypeRecord[],
  options: ResolveAdaptersOptions,
): MailTypeAdapter[] {
  const byId = new Map(records.map(record => [record.id, record]))
  const out: MailTypeAdapter[] = []

  for (const def of BUILTIN_ADAPTERS) {
    const record = byId.get(def.id)
    const enabled = options.minimalMode
      ? MINIMAL_MODE_ADAPTER_IDS.includes(def.id)
      : record?.enabled ?? def.defaultEnabled

    out.push({
      id: def.id,
      kind: 'builtin',
      ui: def.ui,
      name: builtinName(def),
      description: builtinDescription(def),
      enabled,
      priority: def.defaultPriority,
      fallback: def.defaultFallback,
      prompt: def.prompt[options.lang],
      userPrompt: record?.userPrompt,
      params: record?.params,
    })
  }

  const custom = records
    .filter(record => record.kind === 'custom')
    .sort((a, b) => (a.priority ?? 0) - (b.priority ?? 0) || a.createdAt - b.createdAt)

  custom.forEach((record, index) => {
    out.push({
      id: record.id,
      kind: 'custom',
      ui: null,
      name: record.name?.trim() || t('adapters.unnamed'),
      description: '',
      enabled: options.minimalMode ? false : record.enabled ?? true,
      priority: record.priority ?? 100 + index,
      fallback: record.fallback ?? false,
      prompt: record.prompt ?? '',
      params: record.params,
    })
  })

  const sorted = out.sort((a, b) => a.priority - b.priority || a.id.localeCompare(b.id))

  /*
   * 总结永远排在最后：它是兜底，prompt 段与 UI 都不该出现在其它类型之前。
   * 自定义类型的 priority 可能被用户排到 999 以上，所以不能只靠数字排序。
   */
  const summary = sorted.find(adapter => adapter.id === BUILTIN_SUMMARY_ID)
  return summary
    ? [...sorted.filter(adapter => adapter.id !== BUILTIN_SUMMARY_ID), summary]
    : sorted
}

/** 只取「用户可见的适配器标签」（排除总结；总结是兜底内容，不是筛选目标） */
export function filterableAdapters(adapters: MailTypeAdapter[]): MailTypeAdapter[] {
  return adapters.filter(adapter => adapter.enabled && adapter.ui !== 'summary')
}

/** 找到某个适配器（不管启没启用） */
export function adapterById(adapters: MailTypeAdapter[], id: string): MailTypeAdapter | undefined {
  return adapters.find(adapter => adapter.id === id)
}

/** 这封邮件该不该跑总结（总结是兜底，且可被用户关闭） */
export function summaryAdapterEnabled(adapters: MailTypeAdapter[]): boolean {
  return adapters.some(adapter => adapter.id === BUILTIN_SUMMARY_ID && adapter.enabled)
}

/**
 * 「验证码自动复制」的运行时取值。
 *
 * 优先用验证码适配器的 `params.autoCopyCode`；没有显式参数时回退到旧的
 * `app.autoCopyCode`（兼容升级前关掉过这个开关的用户）。
 */
export function adapterAutoCopyCode(
  adapters: MailTypeAdapter[],
  fallback: boolean,
): boolean {
  const value = adapters.find(adapter => adapter.id === BUILTIN_CODE_ID)?.params?.autoCopyCode
  return typeof value === 'boolean' ? value : fallback
}

/** 提示词总字数（配置页预算提示用；只算**生效**的适配器） */
export function adapterPromptChars(adapters: MailTypeAdapter[]): number {
  return adapters
    .filter(adapter => adapter.enabled)
    .reduce(
      (sum, adapter) => sum + adapter.prompt.length + (adapter.userPrompt?.length ?? 0),
      0,
    )
}

/** 粗略 token 估算（中文约 1 char ≈ 1 token，英文约 4 char ≈ 1 token；取 2 作中间值） */
export function estimatePromptTokens(chars: number): number {
  return Math.ceil(chars / 2)
}
