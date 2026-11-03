import type { Expiry, MailTypeMatch, MailTypeRecord } from '~/logic/types'
import { BUILTIN_ADAPTERS } from '~/logic/mail-types/catalog'
import { safeHttpUrl } from '~/logic/mail-types/url'
import { asObject, bool, isPlainObject, num, optionalStr, str } from './common'
// ---------------------------------------------------------------------------
// 邮件类型适配器（Feature 08）
// ---------------------------------------------------------------------------

export const KNOWN_BUILTIN_IDS = new Set<string>(BUILTIN_ADAPTERS.map(def => def.id))

/** 失效信息：绝对时刻 + 进度条分母，两者必须同时有效 */
export function normalizeExpiry(raw: unknown): Expiry | undefined {
  if (!isPlainObject(raw))
    return undefined
  const at = num(raw.at, Number.NaN)
  const totalSeconds = num(raw.totalSeconds, Number.NaN)
  if (!Number.isFinite(at) || at <= 0)
    return undefined
  if (!Number.isFinite(totalSeconds) || totalSeconds <= 0)
    return undefined
  return { at, totalSeconds: Math.round(totalSeconds) }
}

/**
 * 一条类型命中的归一。
 *
 * ⚠ 确认链接的校验在**存储层**就要做（`safeHttpUrl`）：历史数据 / 手改导出文件
 *   都可能塞进一个 `javascript:` URL，而 UI 拿到的就是「点一下打开」的数据。
 *   在这里挡掉比在每个展示 / 点击点重复判断可靠。
 */
export function normalizeMailTypeMatch(raw: unknown): MailTypeMatch | null {
  if (!isPlainObject(raw))
    return null

  const adapterId = str(raw.adapterId).trim()
  if (!adapterId)
    return null

  const adapterName = str(raw.adapterName).slice(0, 80)
  const kind = str(raw.kind)

  if (kind === 'code') {
    const code = str(raw.code).trim()
    if (!code)
      return null
    return { kind, adapterId, adapterName, code, expiry: normalizeExpiry(raw.expiry) }
  }

  if (kind === 'confirm') {
    const url = safeHttpUrl(raw.url)
    if (!url)
      return null
    return {
      kind,
      adapterId,
      adapterName,
      url,
      host: new URL(url).host,
      label: optionalStr(raw.label)?.slice(0, 80),
      expiry: normalizeExpiry(raw.expiry),
    }
  }

  if (kind === 'summary') {
    const minimal = str(raw.minimal).slice(0, 200)
    const text = str(raw.text).slice(0, 4000)
    if (!minimal && !text)
      return null
    return { kind, adapterId, adapterName, minimal, text }
  }

  if (kind === 'custom') {
    const text = str(raw.text).slice(0, 4000)
    if (!text)
      return null
    return { kind, adapterId, adapterName, text }
  }

  return null
}

/** 命中数组的归一：去重（同一个 adapterId 只留第一条）、上限 20 */
export function normalizeMailTypeMatches(raw: unknown): MailTypeMatch[] {
  if (!Array.isArray(raw))
    return []

  const out: MailTypeMatch[] = []
  const seen = new Set<string>()
  for (const item of raw) {
    const match = normalizeMailTypeMatch(item)
    if (!match || seen.has(match.adapterId))
      continue
    seen.add(match.adapterId)
    out.push(match)
    if (out.length >= 20)
      break
  }
  return out
}

/** 链接归一：只留 http(s)、去重、最多 10 条 */
export function normalizeLinks(raw: unknown): string[] | undefined {
  if (!Array.isArray(raw))
    return undefined

  const out: string[] = []
  for (const item of raw) {
    const url = safeHttpUrl(item)
    if (!url || out.includes(url))
      continue
    out.push(url)
    if (out.length >= 10)
      break
  }
  return out.length ? out : undefined
}

/**
 * 适配器参数归一：只保留原始值（string / number / boolean）。
 *
 * 参数是「每个适配器自己解释」的可选字段，存储层不猜语义；但也不能把对象里的
 * 任意结构原样写回 IDB（可能带 undefined / 函数 / 循环引用）。空对象归一成
 * `undefined`，与「没有参数」保持同一种形状。
 */
export function normalizeAdapterParams(raw: unknown): Record<string, unknown> | undefined {
  const value = asObject(raw)
  const out: Record<string, unknown> = {}
  for (const [key, item] of Object.entries(value)) {
    if (typeof item === 'string' || typeof item === 'number' || typeof item === 'boolean')
      out[key] = item
  }
  return Object.keys(out).length ? out : undefined
}

/**
 * 适配器记录归一。
 *
 * - `kind` 不信任输入：id 在 catalog 里才是 builtin，否则按 custom 处理；
 * - builtin 只收 `enabled` / `userPrompt` / `params`（名称 / 提示词 / 优先级由 catalog 决定）；
 * - custom 收整条，并补默认值。
 */
export function normalizeMailTypeRecord(raw: unknown, fallbackKey?: string): MailTypeRecord | null {
  const value = asObject(raw)
  const id = str(value.id, fallbackKey ?? '').trim()
  if (!id)
    return null

  const kind: MailTypeRecord['kind'] = KNOWN_BUILTIN_IDS.has(id) ? 'builtin' : 'custom'
  const createdAt = num(value.createdAt, Date.now())
  const updatedAt = num(value.updatedAt, createdAt)
  const params = normalizeAdapterParams(value.params)

  if (kind === 'builtin') {
    return {
      id,
      kind,
      enabled: value.enabled === undefined ? undefined : bool(value.enabled, true),
      // 不设产品级字数上限：只做运行时类型归一
      userPrompt: value.userPrompt === undefined ? undefined : str(value.userPrompt),
      params,
      createdAt,
      updatedAt,
    }
  }

  return {
    id,
    kind,
    enabled: bool(value.enabled, true),
    name: str(value.name).trim().slice(0, 80) || '未命名类型',
    prompt: str(value.prompt),
    priority: num(value.priority, 100),
    fallback: bool(value.fallback, false),
    params,
    createdAt,
    updatedAt,
  }
}
