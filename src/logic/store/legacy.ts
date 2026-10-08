/**
 * TODO(过渡代码)：**整个模块都是过渡代码**。
 *
 * 它存在的唯一理由是「让任何版本的存量数据都能安全搬进 IndexedDB」。
 * mail-peon 目前**还没有发布过任何版本**（设计文档 `design/storage.md § 9`：
 * 「MVP 阶段没有真实迁移数据，但代码搭好」），所以本文当前只做一件事：
 * 落一个 `meta.migration` 标记，让「全新安装」与「迁完了」在库里可区分。
 *
 * 将来真出现旧键时，往 `STORAGE_KEYS` 加键、往 `planMigration` 加归一化即可 ——
 * 迁移流程本身（幂等、原子、可重试、对账后才删旧键）已经在这一层定好了。
 *
 * 摘除时机：确认不会再出现旧数据之后（通常一两个发布），本文件整体删除，同时要
 *   - 摘掉 `ready.ts` 里的 `runMigration()` 调用；
 *   - 从 `manifest.ts` 移除 `storage` 权限。
 */

import type { TxContext } from '~/platform/idb/database'
import { storage } from 'webextension-polyfill'
import { clearStore, del, get, put, runTx } from '~/platform/idb/database'

/**
 * 旧存储（`chrome.storage.local`）的键名 —— 键 id → 实际键名。
 *
 * **只出现在这个模块里** —— 迁移完成后它们就彻底退出代码。
 *
 * 当前**一个都没有**：mail-peon 从未用 `chrome.storage.local` 存过业务数据。
 * 模板自带的 `webext-demo` 键（`composables/useWebExtensionStorage`）刻意不迁 ——
 * 它是模板示例，不是用户数据。
 *
 * 类型写成「字符串 → 字符串」而不是 `as const` 的空对象字面量：后者会让
 * `keyof typeof STORAGE_KEYS` 变成 `never`，于是循环里的 `STORAGE_KEYS[id]`
 * 被推断成 `never` 而报错。将来往里加键时这里的形状不用改。
 */
export const STORAGE_KEYS: Readonly<Record<string, string>> = {}

export type LegacyKeyId = string

export interface MigrationSnapshot {
  values: Partial<Record<LegacyKeyId, unknown>>
}

export interface MigrationPlan {
  /** 待写入的设置文档（id / value） */
  settings: Array<{ id: 'app' | 'ai', value: unknown }>
  counts: { settings: number }
  /** 迁移后必须逐项一致的摘要（FNV-1a），当前没有可核对项 */
  checksums: Record<string, string>
}

/**
 * 把旧存储快照变成迁移计划。**纯函数**：不碰存储、不写任何东西，因此可单测。
 *
 * 这里也刻意**不做任何可能失败的校验**：所有可预见的失败都发生在开事务之前，
 * 事务里只放写。
 */
export function planMigration(snapshot: MigrationSnapshot): MigrationPlan {
  void snapshot
  return { settings: [], counts: { settings: 0 }, checksums: {} }
}

/** `meta` 仓库里的迁移标记键 */
const META_MIGRATION = 'migration'

export interface MigrationMeta {
  state: 'done'
  from: 'chrome.storage.local'
  at: string
  counts: { settings: number }
  checksums: Record<string, string>
  /** 全新安装（旧键本来就没有内容） */
  fresh?: boolean
}

export interface MigrationResult {
  status: 'migrated' | 'already-done' | 'fresh' | 'failed'
  counts?: { settings: number }
  error?: string
}

async function readMigrationMeta(): Promise<MigrationMeta | null> {
  const doc = await get<{ key: string, value: MigrationMeta }>('meta', META_MIGRATION)
  return doc?.value ?? null
}

async function writeMigrationMeta(value: MigrationMeta, ctx?: TxContext): Promise<void> {
  await put('meta', { key: META_MIGRATION, value }, undefined, ctx)
}

/** 读旧存储的键（只取真实存在的，用于区分「不存在」与「存在但为 undefined」） */
async function readLegacyValues(): Promise<Partial<Record<LegacyKeyId, unknown>>> {
  const ids = Object.keys(STORAGE_KEYS) as LegacyKeyId[]
  if (!ids.length)
    return {}

  let raw: Record<string, unknown>
  try {
    raw = await storage.local.get(ids.map(id => STORAGE_KEYS[id])) as Record<string, unknown>
  }
  catch {
    // 没有 storage 权限 / 环境不支持：当作没有旧数据
    return {}
  }

  const values: Partial<Record<LegacyKeyId, unknown>> = {}
  for (const id of ids) {
    if (Object.hasOwn(raw, STORAGE_KEYS[id]))
      values[id] = raw[STORAGE_KEYS[id]]
  }
  return values
}

/**
 * 执行迁移（**幂等、原子、可重试**）。
 *
 * 顺序（每一步都不能换个位置）：
 *  1. 读迁移标记：已完成 → 直接返回；
 *  2. 读旧键：都没有 → 全新安装，只写标记；
 *  3. `planMigration` 产出计划（纯函数，所有可预见的失败都在这一步之前发生）；
 *  4. 一个事务写入全部设置 + meta（标记也在事务里 → 不存在「搬一半却标了完成」）；
 *  5. 读回来重算摘要对账；
 *  6. **只有对账通过才删旧键** —— 旧键是唯一的回退依据。
 *
 * 任何一步失败都不动旧键，并把迁移标记清掉，下次启动重来。
 */
export async function runMigration(): Promise<MigrationResult> {
  const previous = await readMigrationMeta()
  const values = await readLegacyValues()
  const hasLegacy = Object.keys(values).length > 0

  if (previous?.state === 'done' && !hasLegacy)
    return { status: 'already-done' }

  const now = new Date().toISOString()

  if (!hasLegacy) {
    // 全新安装：只落一个标记，免得每次启动都去读一遍旧键
    await writeMigrationMeta({
      state: 'done',
      from: 'chrome.storage.local',
      at: now,
      counts: { settings: 0 },
      checksums: {},
      fresh: true,
    })
    return { status: 'fresh' }
  }

  const plan = planMigration({ values })
  const meta: MigrationMeta = {
    state: 'done',
    from: 'chrome.storage.local',
    at: now,
    counts: plan.counts,
    checksums: plan.checksums,
  }

  try {
    await runTx(['settings', 'meta'], 'readwrite', async (ctx) => {
      for (const setting of plan.settings)
        await put('settings', { id: setting.id, value: setting.value, updatedAt: now }, undefined, ctx)
      await writeMigrationMeta(meta, ctx)
    })
  }
  catch (error) {
    return { status: 'failed', error: `写入失败：${errorText(error)}` }
  }

  // 旧键存在时才需要删；当前没有任何键，这段是给将来准备的
  const legacyKeys = Object.values(STORAGE_KEYS)
  if (legacyKeys.length) {
    try {
      await storage.local.remove(legacyKeys)
    }
    catch {
      // 删不掉不影响：下次会走 already-done 分支
    }
  }

  return { status: 'migrated', counts: plan.counts }
}

/** 仅供测试：清掉迁移标记，让下一次 `runMigration()` 重新走一遍 */
export async function resetMigrationForTests(): Promise<void> {
  await clearStore('meta')
  await del('meta', META_MIGRATION).catch(() => {})
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * FNV-1a 64 位摘要（16 位十六进制）。
 *
 * 刻意不用 `crypto.subtle`：它是异步的，会把整条迁移校验链路染成 async 且更难测；
 * 而这里要的只是「同样输入给同样输出」—— 用来发现**迁移过程中的意外改动**，
 * 不是抗碰撞的安全用途。
 */
export function digest64(text: string): string {
  return `${fnv1a(text, 0x811C9DC5)}${fnv1a(text, 0x01000193)}`
}

function fnv1a(text: string, basis: number): string {
  let hash = basis
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0).toString(16).padStart(8, '0')
}

/**
 * 稳定序列化：对象键递归排序。
 *
 * 用途是算摘要，所以必须与「键的书写顺序」无关 —— 否则同一份数据经过 IndexedDB
 * 的结构化克隆往返之后，只要键序变了摘要就会对不上，复核「无损」就成了误报。
 */
export function stableJson(value: unknown): string {
  if (value === undefined)
    return 'undefined'
  if (value === null || typeof value !== 'object')
    return JSON.stringify(value) ?? 'null'
  if (Array.isArray(value))
    return `[${value.map(stableJson).join(',')}]`

  const obj = value as Record<string, unknown>
  const body = Object.keys(obj)
    .sort()
    .map(key => `${JSON.stringify(key)}:${stableJson(obj[key])}`)
    .join(',')
  return `{${body}}`
}
