// ---------------------------------------------------------------------------
// 基础取值
// ---------------------------------------------------------------------------

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

export function asObject(value: unknown): Record<string, unknown> {
  // 早期版本可能用 `useWebExtensionStorage` 把对象 JSON 字符串化过 —— 复活它
  if (typeof value === 'string') {
    try {
      return asObject(JSON.parse(value))
    }
    catch {
      return {}
    }
  }
  return isPlainObject(value) ? value : {}
}

export function str(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback
}

export function num(value: unknown, fallback: number): number {
  if (typeof value === 'number' && Number.isFinite(value))
    return value
  if (typeof value === 'string') {
    const parsed = Number(value)
    if (Number.isFinite(parsed))
      return parsed
  }
  return fallback
}

export function bool(value: unknown, fallback: boolean): boolean {
  if (typeof value === 'boolean')
    return value
  if (value === 'true')
    return true
  if (value === 'false')
    return false
  return fallback
}

/**
 * 把任意形状的值补成 `fallback` 的形状。
 *
 * 规则：**只按 fallback 声明过的键合并**。fallback 里没有的键一律丢弃 ——
 * 否则「模型删了一个字段」之后，存量数据里那个字段会一直躺着并被读出来，
 * 类型上却已经不存在了。
 *
 * ⚠ 内部的 `mergeObject` 用 `Record<string, unknown>` 而不是递归泛型：递归泛型
 *   在这里会让 TS 的推断退化（`T[K]` 的映射类型碰上 `unknown` 输入时会报
 *   「unknown 不能赋给 T」）。用 `unknown` 组装完在**唯一一处**收口成 `T` 更简单，
 *   也更诚实地表达了「这一步本来就是运行时的形状对齐，不是类型推导」。
 */
export function mergeDefaults<T>(raw: unknown, fallback: T): T {
  if (Array.isArray(fallback)) {
    const value = typeof raw === 'string' ? safeJson(raw) : raw
    return (Array.isArray(value) ? value : fallback) as T
  }

  if (isPlainObject(fallback))
    return mergeObject(raw, fallback as Record<string, unknown>) as T

  return coerceLike(raw, fallback) as T
}

export function mergeObject(raw: unknown, seed: Record<string, unknown>): Record<string, unknown> {
  const value = asObject(raw)
  const out: Record<string, unknown> = {}
  for (const [key, child] of Object.entries(seed)) {
    if (!(key in value)) {
      out[key] = child
      continue
    }
    out[key] = isPlainObject(child) || Array.isArray(child)
      ? mergeDefaults(value[key], child)
      : coerceLike(value[key], child)
  }
  return out
}

export function safeJson(text: string): unknown {
  try {
    return JSON.parse(text)
  }
  catch {
    return undefined
  }
}

/** 按默认值的类型把原始值掰过来；默认值是 `undefined` 时原样保留（可选字段） */
export function coerceLike(raw: unknown, seed: unknown): unknown {
  if (seed === undefined)
    return raw
  if (typeof seed === 'boolean')
    return bool(raw, seed)
  if (typeof seed === 'number')
    return num(raw, seed)
  if (typeof seed === 'string')
    return str(raw, seed)
  if (seed === null)
    return raw ?? null
  return raw
}

export function optionalStr(value: unknown): string | undefined {
  if (typeof value !== 'string')
    return undefined
  return value
}

/** 正数才认；其余（0 / 负数 / NaN / 字符串垃圾）归 undefined */
export function positiveNumber(value: unknown): number | undefined {
  const n = num(value, Number.NaN)
  return Number.isFinite(n) && n > 0 ? n : undefined
}
