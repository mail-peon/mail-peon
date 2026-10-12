import type { MailProvider, MailProviderDefinition, MailProviderField } from './types'
import { collectNamedAdapters } from '../collect'

/**
 * 邮箱 provider 注册表 + 工厂。
 *
 * **新增一家 provider = 加一个 `providers/<id>/` 目录（`index.ts` 里导出
 * `definition` 与 `create`），然后什么都不用改** —— 本文件按目录约定 glob 它们，
 * Options 的表单也从 `definition.fields` 读，所以「加了 provider 但设置页没有
 * 它的字段」在结构上不可能发生。
 */

interface MailProviderModule {
  definition: MailProviderDefinition
  create: () => MailProvider
}

const PROVIDER_MODULES = collectNamedAdapters(
  import.meta.glob<MailProviderModule>('./providers/*/index.ts', { eager: true }),
  // 目录里可能有非 provider 的模块：只收真正带 definition 的
).filter(mod => !!mod?.definition?.id)

/** 全部 provider 声明，按目录路径排序（顺序即 Options 下拉框的展示顺序） */
export const MAIL_PROVIDERS: MailProviderDefinition[] = PROVIDER_MODULES.map(mod => mod.definition)

export function getMailProviderDefinition(id: string): MailProviderDefinition | undefined {
  return PROVIDER_MODULES.find(mod => mod.definition.id === id)?.definition
}

/**
 * 平台工厂。
 *
 * ⚠ 未知 id 会**抛错而不是回退到默认 provider**：存储里可能残留已废弃的 provider 名
 *   （比如将来的迁移删掉了一家），静默回退会让用户以为「账号还能正常同步」，
 *   而实际上他配的 host / 密码完全没被用上。
 */
export function createMailProvider(id: string): MailProvider {
  const mod = PROVIDER_MODULES.find(item => item.definition.id === id)
  if (!mod)
    throw new Error(`未知的邮箱协议：${id}（可用：${MAIL_PROVIDERS.map(item => item.id).join(' / ')}）`)
  return mod.create()
}

/**
 * 过了消息通道之后的字段：和 `MailProviderField` 完全一样，只有 `key` 收窄成 string。
 *
 * 用 `Omit<..., 'key'> & { key: string }` 而不是重抄一遍字段 —— 以后给
 * `MailProviderField` 加属性，这里会自动跟上，不会变成第三个需要同步的白名单。
 */
export type MailProviderFieldPayload = Omit<MailProviderField, 'key'> & { key: string }

/** 供 Options 展示的可选协议清单（含完整 `fields` 声明） */
export interface MailProviderOptionPayload {
  value: string
  label: string
  hint: string
  availability: MailProviderDefinition['availability']
  availabilityNote?: string
  downloadHint?: MailProviderDefinition['downloadHint']
  fields: MailProviderFieldPayload[]
}

/**
 * provider 声明 → 过消息通道给 Options 用的纯数据载荷。
 *
 * ⚠ 这里**必须是 `...field` 展开，不能手抄字段白名单**。
 *   之前 `background/main.ts` 里是逐个字段抄的（key / label / type / placeholder /
 *   required / default），漏了 `presets` —— 结果 provider 定义里写好的
 *   13 个常用 IMAP 服务器预设，到了 Options 就没了，`v-else-if="field.presets"`
 *   永远不成立，界面一直退化成普通输入框。**用户看得见的功能整个失效，
 *   而单测因为 mock 了这条通道的返回值，全绿。**
 *
 *   展开整个对象后，以后给 `MailProviderField` 加任何数据字段都会自动流过，
 *   不需要有人记得回来补白名单。`MailProviderField` 全是 string / number /
 *   boolean / 数组，结构化克隆没问题。
 *
 * 抽成纯函数的理由是**为了能被测到**：`background/main.ts` 一 import 就会注册
 * 一堆监听器，没法单独测那个 handler；这里没有副作用，可以直接断言。
 */
export function mailProviderOptionPayloads(): MailProviderOptionPayload[] {
  return MAIL_PROVIDERS.map(definition => ({
    value: definition.id,
    label: definition.label,
    hint: definition.hint,
    availability: definition.availability,
    availabilityNote: definition.availabilityNote,
    downloadHint: definition.downloadHint,
    fields: definition.fields.map(field => ({
      ...field,
      // `key` 收窄成 string：静态类型是 `keyof MailAccount['config']`，
      // 过一趟消息通道后要当 `config[key]` 和 `v-for :key` 用。
      key: String(field.key),
    })),
  }))
}

export type {
  FetchResult,
  MailConnection,
  MailConnectionHooks,
  MailProvider,
  MailProviderDefinition,
  MailProviderField,
  RawMail,
  SyncCursor,
  TestConnectionResult,
} from './types'
export { createAccount, MAX_MESSAGES_PER_SYNC } from './types'
