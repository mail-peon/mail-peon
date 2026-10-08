import type { AiProvider } from '~/adapters/ai/types'
import type { AiSettings, Mail } from '~/logic/types'
import { createAiProvider } from '~/adapters/ai/platforms'
import { cleanCode, cleanValidForSeconds, fallbackOutput, parseAiOutput } from './output-schema'
import {
  bodyBudget,
  buildMinimalSystemPrompt,
  buildMinimalUserContent,
  buildSystemPrompt,
  buildUserContent,
  withSchemaHint,
} from './prompt-build'

/**
 * 调 AI 生成 `AiOutput`（完整模式）或只提取验证码（极简模式）。
 *
 * 设计文档的调用流程（`design/ai-prompt-design.md § 9`）：
 *
 *   组装 messages → chat({ json: true }) → JSON.parse → zod.safeParse
 *     → 失败则**重试 1 次** → 再失败 → 降级
 *
 * 三个刻意的取舍：
 *
 * 1. **非流式**（`decisions/open-questions.md` Q4）：AI 必须返回固定 JSON，
 *    流式拼接容易中途格式错，而且这里根本不需要「边出边看」的体验。
 * 2. **重试只有 1 次**：格式错误重试通常有效（模型有随机性），但网络错误重试
 *    往往是浪费时间 —— 第一次超时了，第二次大概率也超时。宁可快速降级，
 *    让用户看到邮件基础信息。
 * 3. **降级不抛错**：`summarize` 永远返回一个 `AiOutput`（带 `degraded: true`）。
 *    抛错会让调用方不得不写 try/catch，而「AI 挂了也要能看到邮件」是产品原则
 *    （`00-overview.md § 7`），不是异常路径。
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
 * 完整模式：一封邮件 → `AiOutput`。
 *
 * `rule` 为 null 表示用内置默认规则（不附加用户提示词）。
 */
export async function summarize(
  mail: Mail,
  rule: Pick<import('~/logic/types').PromptRule, 'id' | 'name' | 'prompt'> | null,
  settings: AiSettings,
  options: SummarizeOptions,
): Promise<import('~/logic/types').AiOutput> {
  if (!settings.apiKey) {
    // 没配 Key 就直接降级，不发请求：一个注定 401 的请求只会让用户多等 20 秒
    return fallbackOutput(mail, '尚未配置 AI API Key（请在「设置 · AI 配置」里填写）')
  }

  let provider: AiProvider
  try {
    provider = providerFrom(settings)
  }
  catch (error) {
    return fallbackOutput(mail, describe(error))
  }

  const system = withSchemaHint(
    buildSystemPrompt(rule, settings, options.browserLang),
    provider,
    'full',
  )

  /*
   * 正文预算按平台能力算，而不是固定用 MAX_BODY_CHARS。
   * 先算一次「不含正文」的固定开销，再把它从 maxInputChars 里扣掉。
   */
  const headerProbe = buildUserContent({ ...mail, bodyText: '', snippet: '' }, 0)
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

      const parsed = parseAiOutput(response.text)
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
        return parsed.output
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

  return fallbackOutput(mail, lastError)
}

/**
 * 极简模式：一封邮件 → 验证码（或 `null`）。
 *
 * ⚠ **不做重试、不做降级**，这是与完整模式的关键差异，理由是产品性的：
 *
 *   极简模式的输出只有一个字段（`code`），没有「部分可用」这回事 ——
 *   拿不到 code 就是彻底没用（设计文档 `design/minimal-mode.md § 6`：
 *   「降级意味着这条验证码没拿到 —— 记录不入库，toast 也不弹」）。
 *   所以这里直接返回 `null`，让调用方丢弃这封邮件，而不是造一条
 *   「有记录但没验证码」的空壳。
 *
 *   重试也免了：极简模式的输入 < 200 token、输出 < 30 token，网络错误的概率
 *   远大于格式错误；而验证码是**时效性极强**的东西 —— 30 秒后再拿到已经没用了，
 *   用户早就手动去邮箱翻了。快速失败比慢速成功更有价值。
 */
/**
 * 极简模式的提取结果。
 *
 * ⚠ `validForSeconds` 与 `code` **一起返回**，而不是再调一次 AI 单独问有效期：
 *   两次调用的结果可能不一致（第二次模型看不到第一次的上下文），
 *   而且极简模式的全部价值就是「便宜 + 快」。一个整数多不了几个 token。
 */
export interface MinimalExtraction {
  code: string
  /** 有效期秒数；邮件没明确写就是 `null` */
  validForSeconds: number | null
}

/**
 * 极简模式：只提取验证码与它的有效期。
 *
 * @returns 提取结果；没有验证码时 `null`
 */
export async function extractCodeOnly(
  mail: Mail,
  settings: AiSettings,
  options: SummarizeOptions,
): Promise<MinimalExtraction | null> {
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
    buildMinimalSystemPrompt(settings, options.browserLang),
    provider,
    'minimal',
  )

  const headerProbe = buildMinimalUserContent({ ...mail, bodyText: '', snippet: '' }, 0)
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

    const parsed = parseMinimalResponse(response.text)
    options.onCall?.({
      mailId: mail.id,
      mode: 'minimal',
      model: provider.config.model,
      attempt: 1,
      latencyMs: Date.now() - started,
      ok: !!parsed,
      error: parsed ? undefined : '模型未提取到验证码',
    })
    return parsed
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

/**
 * 解析极简模式的返回：`{ "code": "...", "validForSeconds": 300 }`。
 *
 * ⚠ 复用 `cleanCode` / `cleanValidForSeconds` 而不是自己写一遍：
 *   这两个字段的清洗规则在两个模式里必须**完全一致** —— 不一致的症状是
 *   「同一封邮件在极简模式提取出的验证码（或倒计时）与完整模式不同」，
 *   这种 bug 极难被发现。
 */
function parseMinimalResponse(text: string): MinimalExtraction | null {
  const trimmed = text.trim()
  if (!trimmed)
    return null

  /**
   * 从一段文本里抠出 `{ code, validForSeconds }`。
   *
   * @param source JSON 文本
   */
  const pick = (source: string): { code: string | null, validForSeconds: unknown } => {
    try {
      const parsed = JSON.parse(source) as { code?: unknown, validForSeconds?: unknown }
      return {
        code: typeof parsed.code === 'string' ? parsed.code : null,
        validForSeconds: parsed.validForSeconds,
      }
    }
    catch {
      return { code: null, validForSeconds: null }
    }
  }

  let picked = pick(trimmed)

  if (picked.code === null) {
    // 容错：模型可能包了代码块 / 带了说明文字
    const start = trimmed.indexOf('{')
    const end = trimmed.lastIndexOf('}')
    if (start !== -1 && end > start)
      picked = pick(trimmed.slice(start, end + 1))
  }

  /*
   * 最后一道：模型没按 JSON 回（返回了裸验证码），用同一套清洗规则兜住。
   * ⚠ 只在这一步用「从文本里抽」，因为这里的输入**整段都应该是验证码**，
   *   不存在「正文里有订单号」的误伤风险。
   *
   * 这种形态下**没有**有效期信息（裸验证码里不可能带），所以给 `null` ——
   * 不要顺手填个默认值。
   */
  if (picked.code === null)
    picked = { code: trimmed, validForSeconds: null }

  const code = cleanCode(picked.code)
  if (!code)
    return null

  return { code, validForSeconds: cleanValidForSeconds(picked.validForSeconds) }
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
