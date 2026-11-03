import type { AiResult, AiResultSchema } from './schema'
import type { AiOutput, Mail, MailTypeAdapter, MailTypeMatch } from '~/logic/types'
import { parseSafeHttpUrl } from '~/logic/mail-types/url'
import { mailStateFlagsFromStates } from '~/logic/types'
import { cleanCode } from './code'
import { MAX_CODE_VALID_FOR_SECONDS, MAX_CONFIRM_VALID_FOR_SECONDS, resolveExpiry } from './expiry'
import { parseJsonLoose } from './json'
import { aiResultSchema } from './schema'
// ---------------------------------------------------------------------------
// 类型命中解析
// ---------------------------------------------------------------------------

export interface ResolveContext {
  adapters: MailTypeAdapter[]
  mail: Mail
}

export function buildMatch(
  adapter: MailTypeAdapter,
  raw: AiResultSchema['types'][number],
  mail: Mail,
): MailTypeMatch | null {
  if (adapter.ui === 'code') {
    const code = cleanCode(raw.code?.value)
    if (!code)
      return null
    return {
      kind: 'code',
      adapterId: adapter.id,
      adapterName: adapter.name,
      code,
      expiry: resolveExpiry(mail, raw.code ?? {}, MAX_CODE_VALID_FOR_SECONDS),
    }
  }

  if (adapter.ui === 'confirm') {
    const parsed = parseSafeHttpUrl(raw.confirm?.url)
    if (!parsed)
      return null
    return {
      kind: 'confirm',
      adapterId: adapter.id,
      adapterName: adapter.name,
      url: parsed.toString(),
      host: parsed.host,
      label: raw.confirm?.label?.trim().slice(0, 80) || undefined,
      expiry: resolveExpiry(mail, raw.confirm ?? {}, MAX_CONFIRM_VALID_FOR_SECONDS),
    }
  }

  if (adapter.ui === 'summary') {
    const minimal = (raw.summary?.minimal ?? '').trim().slice(0, 200)
    const text = (raw.summary?.text ?? '').trim().slice(0, 4000)
    if (!minimal && !text)
      return null
    return { kind: 'summary', adapterId: adapter.id, adapterName: adapter.name, minimal, text }
  }

  // 自定义类型：只认一段文本
  const text = (raw.custom?.text ?? '').trim().slice(0, 4000)
  if (!text)
    return null
  return { kind: 'custom', adapterId: adapter.id, adapterName: adapter.name, text }
}

/**
 * 业务层二次校验。
 *
 * 返回的 `types` 已按适配器优先级排序、已应用兜底；`stateFlags` 已转成位掩码。
 */
export function resolveAiTypes(
  parsed: AiResultSchema,
  context: ResolveContext,
): AiResult {
  const enabled = new Map(
    context.adapters
      .filter(adapter => adapter.enabled)
      .map(adapter => [adapter.id, adapter]),
  )

  const entries: Array<{ match: MailTypeMatch, priority: number, fallback: boolean }> = []
  const seen = new Set<string>()

  for (const raw of parsed.types) {
    const adapter = enabled.get(raw.adapterId)
    if (!adapter || seen.has(adapter.id))
      continue
    const match = buildMatch(adapter, raw, context.mail)
    if (!match)
      continue
    seen.add(adapter.id)
    entries.push({ match, priority: adapter.priority, fallback: adapter.fallback })
  }

  /*
   * 兜底规则（需求 8）：
   *   - 只要有任何非兜底类型命中，所有兜底类型都不输出（验证码命中 ⇒ 没有总结）；
   *   - 否则只保留优先级最高的一个兜底（自定义兜底 vs 总结，谁靠前谁赢）。
   *
   * ⚠ 这是 **JS 强制**的，不依赖模型是否遵守提示词里的「兜底」说明。
   */
  const primary = entries.filter(entry => !entry.fallback)
  const chosen = primary.length
    ? primary
    : entries
        .filter(entry => entry.fallback)
        .sort((a, b) => a.priority - b.priority)
        .slice(0, 1)

  const types = chosen
    .sort((a, b) => a.priority - b.priority)
    .map(entry => entry.match)

  return {
    output: deriveAiOutput(types),
    stateFlags: mailStateFlagsFromStates(parsed.states),
  }
}

/** 从 types 派生兼容旧 UI 的字段（唯一真相仍是 `types`） */
export function deriveAiOutput(types: MailTypeMatch[]): AiOutput {
  const codeMatch = types.find((match): match is Extract<MailTypeMatch, { kind: 'code' }> => match.kind === 'code')
  const summaryMatch = types.find((match): match is Extract<MailTypeMatch, { kind: 'summary' }> => match.kind === 'summary')

  return {
    types,
    minimal: summaryMatch?.minimal,
    summary: summaryMatch?.text,
    code: codeMatch?.code ?? null,
    validForSeconds: codeMatch?.expiry?.totalSeconds ?? null,
  }
}

/** 校验 + 装配（AI 返回的原文 → AiResult，失败返回 error） */
export function parseAiResult(
  text: string,
  context: ResolveContext,
): { ok: true, result: AiResult } | { ok: false, error: string } {
  let json: unknown
  try {
    json = parseJsonLoose(text)
  }
  catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }

  const parsed = aiResultSchema.safeParse(json)
  if (!parsed.success)
    return { ok: false, error: `AI 输出不符合 schema：${JSON.stringify(parsed.error.issues).slice(0, 300)}` }

  return { ok: true, result: resolveAiTypes(parsed.data, context) }
}
