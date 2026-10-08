import type { AiSettings, AppSettings } from '~/logic/types'
import type { TxContext } from '~/platform/idb/database'
import { get, put } from '~/platform/idb/database'
import { normalizeAiSettings, normalizeAppSettings } from './migrations'
import { withReady } from './ready'

/**
 * `settings` 仓库里的两个单文档：`app` / `ai`。
 *
 * 拆成两份而不是一个 `Settings`（设计文档 `data-model.md § 4`）：AI 配置与 App 配置
 * 的读写时机完全不同 —— 心跳每轮都要读 `app`（模式 / 保留数量），而 `ai` 只在真正
 * 调 AI 时读。合成一份的话每次心跳都要把 API Key 一起读进内存。
 *
 * ⚠ 这一层只管「取出来 / 放进去」，**不做领域归一化**：形状归一在
 *   `migrations.ts` 的纯函数里，由下面的 `read*` 调用。归一化混进 put 会让
 *   「写进去的形状」和「读出来的形状」有可能分叉。
 */

export type SettingId = 'app' | 'ai'

export interface SettingDoc {
  id: SettingId
  /** 库里可能躺着旧形状的值，读的一方必须先归一 —— 所以这里是 `unknown` */
  value: unknown
  updatedAt: string
}

/** 读原始文档值（可能是 undefined、旧形状、或 JSON 字符串）；不做任何归一 */
export async function readRawSetting(id: SettingId): Promise<unknown> {
  const doc = await get<SettingDoc>('settings', id)
  return doc?.value
}

/**
 * 写文档（`ctx` 用于并入调用方事务，见 `platform/idb` 的 put 参数顺序：
 * store, value, key, ctx）。
 *
 * `updatedAt` 在这里统一盖：调用方拿不到写时间，也就写不出不一致的时间戳。
 * 键的位置固定传 `undefined` —— settings 是内部键仓库（keyPath 为 'id'），
 * 多传一个键 IDB 会直接抛错。
 */
export async function writeSetting(id: SettingId, value: unknown, ctx?: TxContext): Promise<void> {
  const doc: SettingDoc = { id, value, updatedAt: new Date().toISOString() }
  await put('settings', doc, undefined, ctx)
}

/**
 * ⚠ `readAppSettings` / `readAiSettings` 都套了 `withReady`，而 `pruneMails` 之类
 *   的内部函数会调它们 —— 这没问题：`withReady` 只 await 一个已 resolve 的 promise，
 *   底下是**微任务**，不会把 IDB 事务的控制权交回事件循环（那才会让事务提前提交）。
 */
export const readAppSettings = withReady(async (): Promise<AppSettings> => {
  return normalizeAppSettings(await readRawSetting('app'))
})

export const writeAppSettings = withReady(async (settings: AppSettings, ctx?: TxContext): Promise<void> => {
  await writeSetting('app', normalizeAppSettings(settings), ctx)
})

export const readAiSettings = withReady(async (): Promise<AiSettings> => {
  return normalizeAiSettings(await readRawSetting('ai'))
})

export const writeAiSettings = withReady(async (settings: AiSettings, ctx?: TxContext): Promise<void> => {
  await writeSetting('ai', normalizeAiSettings(settings), ctx)
})

/** 部分更新（Options 页每个开关单独提交，不好每次都把整份设置传上来） */
export const patchAppSettings = withReady(async (patch: Partial<AppSettings>): Promise<AppSettings> => {
  const next = normalizeAppSettings({ ...await readAppSettings(), ...patch })
  await writeAppSettings(next)
  return next
})

export const patchAiSettings = withReady(async (patch: Partial<AiSettings>): Promise<AiSettings> => {
  const next = normalizeAiSettings({ ...await readAiSettings(), ...patch })
  await writeAiSettings(next)
  return next
})
