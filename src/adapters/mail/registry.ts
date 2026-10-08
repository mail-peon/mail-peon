import type { MailProvider, MailProviderDefinition } from './types'
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

/** 供 Options 展示的可选协议清单 */
export const MAIL_PROVIDER_OPTIONS = MAIL_PROVIDERS.map(definition => ({
  value: definition.id,
  label: definition.label,
  hint: definition.hint,
  availability: definition.availability,
  availabilityNote: definition.availabilityNote,
}))

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
