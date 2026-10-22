import type { AiResult } from './output-schema'
import type { AiProvider } from '~/adapters/ai/types'
import type { AiSettings, Mail, MailTypeAdapter, MailTypeMatch, PromptRule } from '~/logic/types'
import { createAiProvider } from '~/adapters/ai/platforms'
import { fallbackResult, parseAiResult } from './output-schema'
import {
  bodyBudget,
  buildMinimalUserContent,
  buildSystemPrompt,
  buildUserContent,
  promptExceedsBudget,
  withSchemaHint,
} from './prompt-build'

/**
 * 调 AI 分析一封邮件（完整模式）或只提取验证码/确认（极简模式）。
 *
 * 设计文档的调用流程（`design/ai-prompt-design.md § 9`）：
 *
 *   组装 messages → chat({ json }) → JSON.parse → zod.safeParse
 *     → 业务二次校验 → 失败则**重试 1 次** → 再失败 → 降级
 *
 * 三个刻意的取舍：
 *
 * 1. **非流式**：AI 必须返回固定 JSON，流式拼接容易中途格式错。
 * 2. **重试只有 1 次**：格式错误重试通常有效，网络错误重试往往浪费时间。
 * 3. **降级不抛错**：`summarize` 永远返回一个 `AiResult`（带 `degraded: true`）。
 */

export interface SummarizeOptions {
  /** 浏览器语言（`navigator.language`）；由调用方传，便于单测 */
  browserLang: string
  /** 观测钩子：每次调用记录 (mailId, model, latencyMs) */
  onCall?: (info: CallInfo) => void
}

export interface CallInfo {
  mailId: string
  mode: 'full' | 'minimal'
  model: string
  attempt: number
  latencyMs: number
  ok: boolean
  error?: string
}

function providerFrom(settings: AiSettings): AiProvider {
  return createAiProvider(settings.platform, {
    baseUrl: settings.baseUrl,
    apiKey: settings.apiKey,
    model: settings.model,
    maxTokens: settings.maxTokens,
    thinking: settings.thinking,
  })
}

/**
 * 完整模式：一封邮件 → `AiResult`（类型命中 + 状态位）。
 *
 * `rule` 为 null 表示用内置默认规则（不附加用户提示词）。
 */
export async function summarize(
  mail: Mail,
  adapters: MailTypeAdapter[],
  rule: Pick<PromptRule, 'id' | 'name' | 'prompt'> | null,
  settings: AiSettings,
  options: SummarizeOptions,
): Promise<AiResult> {
  if (!settings.apiKey) {
    // 没配 Key 就直接降级，不发请求：一个注定 401 的请求只会让用户多等 20 秒
    return fallbackResult(mail, adapters, '尚未配置 AI API Key（请在「设置 · AI 配置」里填写）')
  }

  let provider: AiProvider
  try {
    provider = providerFrom(settings)
  }
  catch (error) {
    return fallbackResult(mail, adapters, describe(error))
  }

  const system = withSchemaHint(
    buildSystemPrompt({
      adapters,
      rule,
      settings,
      browserLang: options.browserLang,
      mode: 'full',
    }),
    provider,
    'full',
  )

  /*
   * 正文预算按平台能力算，而不是固定用 MAX_BODY_CHARS。
   * 先算一次「不含正文」的固定开销（含 Links），再把它从 maxInputChars 里扣掉。
   */
  const headerProbe = buildUserContent({ ...mail, bodyText: '', snippet: '' }, 0)
  if (promptExceedsBudget(provider, system, headerProbe.length)) {
    return fallbackResult(
      mail,
      adapters,
      '分类规则提示词过长，超出当前模型的上下文预算；请减少启用的分类规则或缩短提示词',
    )
  }

  const maxBody = bodyBudget(provider, system, headerProbe.length)
  const user = buildUserContent(mail, maxBody)

  let lastError = '未知错误'

  for (let attempt = 1; attempt <= 2; attempt++) {
    const started = Date.now()
    try {
      const response = await provider.protocol.chat(
        {
          system,
          messages: [{ role: 'user', content: user }],
          json: provider.capabilities.nativeJson,
        },
        provider.config,
      )

      const parsed = parseAiResult(response.text, { adapters, mail })
      options.onCall?.({
        mailId: mail.id,
        mode: 'full',
        model: provider.config.model,
        attempt,
        latencyMs: Date.now() - started,
        ok: parsed.ok,
        error: parsed.ok ? undefined : parsed.error,
      })

      if (parsed.ok)
        return parsed.result
      lastError = parsed.error
    }
    catch (error) {
      lastError = describe(error)
      options.onCall?.({
        mailId: mail.id,
        mode: 'full',
        model: provider.config.model,
        attempt,
        latencyMs: Date.now() - started,
        ok: false,
        error: lastError,
      })
    }
  }

  return fallbackResult(mail, adapters, lastError)
}

/**
 * 极简模式：一封邮件 → 类型命中（或 `null`）。
 *
 * ⚠ **不做重试、不做降级**，这是与完整模式的关键差异：
 *
 *   极简模式的输出是「验证码 + 确认」两类，没有「部分可用」这回事 ——
 *   两个都没命中就是彻底没用。所以这里直接返回 `null`，让调用方丢弃这封邮件，
 *   而不是造一条「有记录但什么都没有」的空壳。
 *
 *   重试也免了：输入很小、输出很小，网络错误的概率远大于格式错误；而验证码是
 *   **时效性极强**的东西 —— 30 秒后再拿到已经没用了。
 *
 * @returns 命中的类型；没有命中时 `null`
 */
export async function extractMinimalTypes(
  mail: Mail,
  adapters: MailTypeAdapter[],
  settings: AiSettings,
  options: SummarizeOptions,
): Promise<MailTypeMatch[] | null> {
  if (!settings.apiKey)
    return null

  let provider: AiProvider
  try {
    provider = providerFrom(settings)
  }
  catch {
    return null
  }

  const system = withSchemaHint(
    buildSystemPrompt({
      adapters,
      rule: null,
      settings,
      browserLang: options.browserLang,
      mode: 'minimal',
    }),
    provider,
    'minimal',
  )

  const headerProbe = buildMinimalUserContent({ ...mail, bodyText: '', snippet: '' }, 0)
  if (promptExceedsBudget(provider, system, headerProbe.length))
    return null

  const maxBody = bodyBudget(provider, system, headerProbe.length)
  const user = buildMinimalUserContent(mail, maxBody)

  const started = Date.now()
  try {
    const response = await provider.protocol.chat(
      {
        system,
        messages: [{ role: 'user', content: user }],
        json: provider.capabilities.nativeJson,
      },
      provider.config,
    )

    const parsed = parseAiResult(response.text, { adapters, mail })
    options.onCall?.({
      mailId: mail.id,
      mode: 'minimal',
      model: provider.config.model,
      attempt: 1,
      latencyMs: Date.now() - started,
      ok: parsed.ok && parsed.result.output.types.length > 0,
      error: parsed.ok ? undefined : parsed.error,
    })

    if (!parsed.ok || !parsed.result.output.types.length)
      return null
    return parsed.result.output.types
  }
  catch (error) {
    options.onCall?.({
      mailId: mail.id,
      mode: 'minimal',
      model: provider.config.model,
      attempt: 1,
      latencyMs: Date.now() - started,
      ok: false,
      error: describe(error),
    })
    return null
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** AI 连通性探测（Options 的「测试连通」按钮） */
export async function testAiConnection(settings: AiSettings): Promise<{
  ok: boolean
  detail?: string
  error?: string
  latencyMs?: number
}> {
  if (!settings.apiKey)
    return { ok: false, error: '尚未填写 API Key' }

  try {
    const provider = providerFrom(settings)
    const result = await provider.protocol.ping(provider.config)
    if (!result.ok)
      return result

    return {
      ok: true,
      detail: `${provider.name} · ${provider.config.model} 连接成功`,
      latencyMs: result.latencyMs,
    }
  }
  catch (error) {
    return { ok: false, error: describe(error) }
  }
}
