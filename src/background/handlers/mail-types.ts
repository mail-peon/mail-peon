import type { MailTypeRecord } from '~/logic/types'
import { nanoid } from 'nanoid'
import { onMessage } from 'webext-bridge/background'
import { resolveMailTypeAdapters } from '~/logic/mail-types/resolve'
import { broadcastToExtension } from '~/logic/messaging'
import { deleteMailTypeRecord, listMailTypeRecords, moveCustomMailType, nextCustomPriority, readMailTypeRecord, upsertMailTypeRecord } from '~/logic/store/mail-types'
import { ensureStoreReady } from '~/logic/store/ready'
import { readAppSettings } from '~/logic/store/settings'

// ---------------------------------------------------------------------------
// 消息：邮件类型适配器（Feature 08）
// ---------------------------------------------------------------------------

/**
 * 把「catalog + override + 自定义」合并成 UI 需要的运行时视图。
 *
 * 极简模式的开关锁定是**生效层**的事：这里返回的 `enabled` 已经是
 * 「极简模式强制 code+confirm」之后的值，UI 只管渲染 + 禁用开关。
 */
async function effectiveMailTypes() {
  const [records, app] = await Promise.all([listMailTypeRecords(), readAppSettings()])
  return resolveMailTypeAdapters(records, {
    minimalMode: app.minimalMode,
    lang: 'zh',
  })
}

/**
 * 极简模式下适配器配置是**只读**的（模式 overlay 强制 code+confirm）。
 *
 * 例外：适配器自己的 `params` 仍然可写 —— 例如「验证码自动复制」已经从通用设置
 * 迁到验证码适配器里，它控制的是行为，不是「这个类型生不生效」。如果连它也锁住，
 * 极简模式用户就再也关不掉自动复制了。
 */
async function adapterEditGuard(
  patch?: Record<string, unknown>,
): Promise<{ ok: false, error: string } | null> {
  const app = await readAppSettings()
  if (!app.minimalMode)
    return null

  const keys = Object.keys(patch ?? {})
  if (keys.length > 0 && keys.every(key => key === 'params'))
    return null

  return { ok: false as const, error: '极简模式下分类规则开关被锁定，请切到「自定义」模式' }
}

export function registerMailTypeHandlers() {
  onMessage('mail-types:list', async () => {
    await ensureStoreReady()
    return { adapters: await effectiveMailTypes() }
  })

  /**
   * 更新一条适配器。
   *
   * - 内置：只接受 `enabled` / `userPrompt` / `params`（名称 / 提示词 / 优先级由 catalog 决定）；
   * - 自定义：接受 `name` / `prompt` / `fallback` / `enabled` / `params`。
   *
   * 不存在时对内置是「新建一条 override」，对自定义是错误（防止 UI 拿错 id）。
   */
  onMessage('mail-types:update', async ({ data }) => {
    await ensureStoreReady()
    const guard = await adapterEditGuard(data.patch)
    if (guard)
      return guard

    const records = await listMailTypeRecords()
    const existing = records.find(record => record.id === data.id)
    const isBuiltin = data.id.startsWith('builtin:')

    if (!isBuiltin && !existing)
      return { ok: false as const, error: '自定义类型不存在' }

    const now = Date.now()
    const base: MailTypeRecord = existing ?? {
      id: data.id,
      kind: isBuiltin ? 'builtin' : 'custom',
      createdAt: now,
      updatedAt: now,
    }

    const next: MailTypeRecord = { ...base, updatedAt: now }

    if (typeof data.patch.enabled === 'boolean')
      next.enabled = data.patch.enabled

    if (data.patch.params && typeof data.patch.params === 'object' && !Array.isArray(data.patch.params))
      next.params = { ...(next.params ?? {}), ...data.patch.params }

    if (isBuiltin) {
      if (typeof data.patch.userPrompt === 'string')
        next.userPrompt = data.patch.userPrompt
    }
    else {
      if (typeof data.patch.name === 'string')
        next.name = data.patch.name
      if (typeof data.patch.prompt === 'string')
        next.prompt = data.patch.prompt
      if (typeof data.patch.fallback === 'boolean')
        next.fallback = data.patch.fallback
    }

    await upsertMailTypeRecord(next)
    broadcastToExtension('data:changed', { reason: 'mail-types' })
    return { ok: true as const }
  })

  onMessage('mail-types:create', async ({ data }) => {
    await ensureStoreReady()
    const guard = await adapterEditGuard()
    if (guard)
      return guard

    const name = data.name.trim()
    const prompt = data.prompt.trim()
    if (!name)
      return { ok: false as const, error: '请填写类型名' }
    if (!prompt)
      return { ok: false as const, error: '请填写提示词' }

    const records = await listMailTypeRecords()
    const now = Date.now()
    const id = `custom:${nanoid(10)}`

    await upsertMailTypeRecord({
      id,
      kind: 'custom',
      name,
      prompt,
      enabled: true,
      fallback: data.fallback === true,
      priority: nextCustomPriority(records),
      createdAt: now,
      updatedAt: now,
    })

    broadcastToExtension('data:changed', { reason: 'mail-types' })
    return { ok: true as const, id }
  })

  onMessage('mail-types:delete', async ({ data }) => {
    await ensureStoreReady()
    const guard = await adapterEditGuard()
    if (guard)
      return guard

    // 内置不能删；删除请求对内置等价于「恢复默认」（清掉 override）
    await deleteMailTypeRecord(data.id)
    broadcastToExtension('data:changed', { reason: 'mail-types' })
    return { ok: true as const }
  })

  onMessage('mail-types:reset', async ({ data }) => {
    await ensureStoreReady()
    const guard = await adapterEditGuard()
    if (guard)
      return guard

    const existing = await readMailTypeRecord(data.id)
    if (existing?.kind === 'custom')
      return { ok: false as const, error: '自定义类型没有默认值' }

    await deleteMailTypeRecord(data.id)
    broadcastToExtension('data:changed', { reason: 'mail-types' })
    return { ok: true as const }
  })

  onMessage('mail-types:move', async ({ data }) => {
    await ensureStoreReady()
    const guard = await adapterEditGuard()
    if (guard)
      return guard

    const existing = await readMailTypeRecord(data.id)
    if (!existing || existing.kind !== 'custom')
      return { ok: false as const, error: '只有自定义类型可以排序' }

    await moveCustomMailType(data.id, data.direction)
    broadcastToExtension('data:changed', { reason: 'mail-types' })
    return { ok: true as const }
  })
}
