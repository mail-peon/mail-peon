import type { RuleCache } from './rule-engine'
import type { Notifier, ToastPayload } from '~/logic/notification/types'
import type { AiSettings, AppSettings, CodeMatch, Mail, MailAccount, MailRetention, PromptRule } from '~/logic/types'
import { resolveMailTypeAdapters } from '~/logic/mail-types/resolve'
import { toastCaption } from '~/logic/notification/copy'
import { applyRuleStateFlags, shouldAutoCopyCode } from '~/logic/rules/matcher'
import { listMailTypeRecords } from '~/logic/store/mail-types'
import { setCopyStatus, upsertMail } from '~/logic/store/mails'
import { listRules } from '~/logic/store/rules'
import { readAiSettings, readAppSettings } from '~/logic/store/settings'
import { DEFAULT_RULE_ID, MINIMAL_RETENTION } from '~/logic/types'
import { looksLikeActionableEmail } from './prefilter'
import { createLimiter } from './queue'
import { pickRule } from './rule-engine'
import { extractMinimalTypes, summarize } from './summarize'

/**
 * 邮件处理流水线 —— `adapters/mail/mailbox.ts` 与业务逻辑之间的那层。
 *
 * 存在的理由：`mailbox.ts` 只该关心「怎么把邮件从服务器拿下来」，它**不该知道**
 * 两种模式的区别、AI 怎么调、验证码怎么复制。把那些收在这个接口的实现里之后，
 * 同步编排可以用一个假 pipeline 跑完单测 —— 不需要网络、AI、真邮箱。
 *
 * 两种模式的分支在这里分开（Feature 08）：
 *
 *   极简：预筛 → 只带 code/confirm 适配器 → 自动复制 → toast → 只写最小记录
 *   自定义：生效适配器 + 规则 → AI → 状态位 + 类型命中 → 落库 → badge / toast
 */
export type MailOutcome = 'saved' | 'skipped'

export interface MailPipeline {
  /**
   * 读「过滤用」的设置。
   *
   * 单独一个方法而不是让编排层直接读存储：`adapters/` 这一层刻意不依赖
   * `logic/store/`（它要能在没有 IndexedDB 的环境里被测）。
   */
  readSettingsForFilter: () => Promise<Pick<AppSettings, 'minimalMode' | 'blockedEnabled'>>
  /** 处理一封邮件 */
  process: (mail: Mail, account: MailAccount, retention?: MailRetention) => Promise<MailOutcome>
}

export interface MailPipelineDeps {
  notifier: Notifier
  /** 浏览器语言（`navigator.language`） */
  browserLang?: string
  /** 规则缓存（跨轮复用；用户改规则时由 background 显式失效） */
  ruleCache?: RuleCache
  /** 观测钩子：每次 AI 调用记录 (mailId, model, latencyMs) */
  onAiCall?: (info: import('./summarize').CallInfo) => void
}

/**
 * 复制的上限时长。
 *
 * 比 `clipboard.ts` 里那一级（2 秒）稍宽松：这里是**最外层保险**，
 * 正常情况下内层会先超时并返回 false，这一层永远不会触发。
 * 它防的是「内层超时被改坏 / 换了实现没有超时」。
 */
const COPY_TIMEOUT_MS = 3000

/** toast 投递的上限时长。理由同 `COPY_TIMEOUT_MS` */
const TOAST_TIMEOUT_MS = 3000

/**
 * 投 toast，并且**保证不抛错、不挂住**。
 *
 * ⚠ 与 `copyWithTimeout` 是同一类保护，只是对象换成 toast。
 *   扩展自己的页面没有 content script，`webext-bridge` 会在异步回调里抛错，
 *   调用方的 try/catch 拦不住；投递本身还可能永不返回。
 *   所以这里的语义是「尽力投一次，投不到就算了」。
 */
async function notifySafe(notifier: Notifier, payload: ToastPayload): Promise<void> {
  try {
    const timeout = new Promise<void>((resolve) => {
      setTimeout(resolve, TOAST_TIMEOUT_MS)
    })
    await Promise.race([notifier.showToast(payload), timeout])
  }
  catch (error) {
    console.warn('[mail-peon] 投递 toast 失败（不影响入库）', error)
  }
}

/**
 * 复制验证码，并且**保证在 `COPY_TIMEOUT_MS` 内返回**。
 *
 * ⚠ 返回值是「是否复制成功」；超时算失败。
 *   剪贴板是锦上添花：**任何 notifier 实现都不该有能力阻塞入库**。
 */
async function copyWithTimeout(notifier: Notifier, code: string): Promise<boolean> {
  try {
    const timeout = new Promise<false>((resolve) => {
      setTimeout(resolve, COPY_TIMEOUT_MS, false)
    })
    return await Promise.race([notifier.copyToClipboard(code), timeout])
  }
  catch (error) {
    console.warn('[mail-peon] 复制验证码失败（不影响入库）', error)
    return false
  }
}

/** 一轮同步里的 AI 并发上限（`features/02-ai-summary.md § 4`：默认 3） */
const AI_CONCURRENCY = 3

/**
 * 由「入库时刻 + 有效期秒数」算出验证码的失效时刻。
 *
 * 基准取 `min(receivedAt, now)`：`receivedAt` 因时钟跳变落在未来时，
 * 相加会给出虚高的失效时刻。对补拉的旧邮件它会给出更保守（更容易显示「已失效」）
 * 的结果 —— 保守的那一侧才是安全的一侧。
 *
 * @param mail 邮件（用它的 `receivedAt`）
 * @param validForSeconds AI 读到的有效期；`null` / 缺失表示邮件没写
 * @returns 失效时刻；没有明确有效期时 `undefined`
 */
export function deriveCodeExpiresAt(mail: Mail, validForSeconds: number | null | undefined): number | undefined {
  return deriveCodeExpiry(mail, validForSeconds).expiresAt
}

/**
 * 验证码有效期的**总秒数**（进度条的分母）。
 *
 * 与 `deriveCodeExpiresAt` 共用同一个校验：无效输入一律返回 `undefined`，
 * 于是 `codeExpiresAt` 与 `codeValidForSeconds` **要么都有、要么都没有**。
 */
export function deriveCodeValidForSeconds(
  validForSeconds: number | null | undefined,
): number | undefined {
  if (typeof validForSeconds !== 'number' || !Number.isFinite(validForSeconds) || validForSeconds <= 0)
    return undefined
  return validForSeconds
}

function deriveCodeExpiry(
  mail: Mail,
  validForSeconds: number | null | undefined,
): { expiresAt?: number, validForSeconds?: number } {
  const seconds = deriveCodeValidForSeconds(validForSeconds)
  if (seconds === undefined)
    return {}

  const base = Math.min(mail.receivedAt, Date.now())
  return { expiresAt: base + seconds * 1000, validForSeconds: seconds }
}

/** 适配器提示词的语言必须与基础 system 一致 */
function promptLang(settings: AiSettings, browserLang: string): 'zh' | 'en' {
  if (settings.outputLanguage === 'auto-email')
    return 'en'
  return browserLang.toLowerCase().startsWith('zh') ? 'zh' : 'en'
}

async function loadAdapters(
  minimalMode: boolean,
  settings: AiSettings,
  browserLang: string,
) {
  const records = await listMailTypeRecords()
  return resolveMailTypeAdapters(records, {
    minimalMode,
    lang: promptLang(settings, browserLang),
  })
}

export function createMailPipeline(deps: MailPipelineDeps): MailPipeline {
  const browserLang = deps.browserLang ?? 'zh-CN'
  const limiter = createLimiter(AI_CONCURRENCY)
  const { notifier } = deps

  async function processMinimal(mail: Mail, app: AppSettings): Promise<MailOutcome> {
    /*
     * 1. 预筛：验证码 OR 确认线索都不像的**直接丢弃**，连 AI 都不调。
     *
     * ⚠ 这一步是极简模式**省钱的关键**。没有它，用户的每一封邮件都会烧一次
     *   AI 调用 —— 而极简模式的用户通常在一个收验证码的邮箱里同时收着几百封
     *   通知邮件。
     */
    if (!looksLikeActionableEmail(mail)) {
      console.warn(`[mail-peon] 预筛跳过（不像验证码 / 确认邮件）：${mail.subject}`)
      return 'skipped'
    }

    const settings = await readAiSettings()
    if (!settings.apiKey) {
      console.warn('[mail-peon] 极简模式需要 AI Key，但当前没有配置 —— 邮件不会被处理')
      return 'skipped'
    }

    // 极简模式强制只跑 code + confirm（模式 overlay，不读用户的开关）
    const adapters = await loadAdapters(true, settings, browserLang)

    const types = await limiter.run(() => extractMinimalTypes(mail, adapters, settings, {
      browserLang,
      onCall: deps.onAiCall,
    }))

    // 2. 两个都没命中 → 丢弃。设计文档明确：不入库、不弹 toast
    if (!types?.length) {
      console.warn(`[mail-peon] 未提取到验证码 / 确认链接（已丢弃）：${mail.subject}`)
      return 'skipped'
    }

    const codeMatch = types.find((match): match is CodeMatch => match.kind === 'code')

    /*
     * 3. 自动复制（`autoCopyCode` 是一个**普通开关**，极简模式不再恒 true）。
     *    关掉时验证码照旧提取、入库，只是不写剪贴板，toast 给「点击复制」。
     */
    const autoCopy = shouldAutoCopyCode(app, null)
    const copied = codeMatch && autoCopy ? await copyWithTimeout(notifier, codeMatch.code) : false
    const toastStatus: 'copied' | 'failed' | 'manual'
      = autoCopy ? (copied ? 'copied' : 'failed') : 'manual'

    /*
     * 4. 极简模式的记录是**瘦身**的：正文 / 链接都不存。
     *    确认链接已经落在 match 里，按钮不需要正文。
     */
    const minimalMail: Mail = {
      ...mail,
      snippet: '',
      bodyText: undefined,
      bodyHtml: undefined,
      links: undefined,
      // 极简模式不计算状态标签（不跑总结 / 广告判定）
      stateFlags: 0,
      processing: 'skipped',
      code: codeMatch?.code ?? null,
      codeExpiresAt: codeMatch?.expiry?.at,
      codeValidForSeconds: codeMatch?.expiry?.totalSeconds,
      ai: {
        types,
        code: codeMatch?.code ?? null,
        validForSeconds: codeMatch?.expiry?.totalSeconds ?? null,
      },
      copyStatus: codeMatch ? (autoCopy ? (copied ? 'copied' : 'failed') : 'none') : 'none',
    }

    // 极简模式写死 50 条（不暴露设置项）
    await upsertMail(minimalMail, MINIMAL_RETENTION)
    console.warn(`[mail-peon] 已入库：${minimalMail.id}（${types.map(type => type.kind).join(', ')}）`)

    /*
     * 5. 只有验证码弹 toast；确认邮件不弹（产品决定）。
     *    toast 走 `notifySafe`：投递失败不该打断整封邮件的处理。
     */
    if (codeMatch) {
      await notifySafe(notifier, {
        kind: 'code',
        mailId: minimalMail.id,
        from: toastCaption(minimalMail.from),
        code: codeMatch.code,
        status: toastStatus,
      })
    }

    notifier.notifyMailUpdated(minimalMail.id)
    return 'saved'
  }

  async function processFull(mail: Mail, app: AppSettings, retention?: MailRetention): Promise<MailOutcome> {
    const [settings, rule] = await Promise.all([
      readAiSettings(),
      resolveRule(mail),
    ])

    const adapters = await loadAdapters(false, settings, browserLang)

    const { output, stateFlags } = await limiter.run(() => summarize(mail, adapters, rule, settings, {
      browserLang,
      onCall: deps.onAiCall,
    }))

    /*
     * 规则能清掉 `Ad` 位（`features/04-exclude-ads.md § 3`），
     * 但只动广告那一位 —— 紧急度由 AI / 启发式决定。
     */
    const resolvedFlags = applyRuleStateFlags(stateFlags, rule)
    const codeMatch = output.types.find(
      (match): match is CodeMatch => match.kind === 'code',
    )

    const stored: Mail = {
      ...mail,
      processing: 'sent',
      ai: output,
      stateFlags: resolvedFlags,
      codeExpiresAt: codeMatch?.expiry?.at,
      codeValidForSeconds: codeMatch?.expiry?.totalSeconds,
      ruleId: rule.id === DEFAULT_RULE_ID ? undefined : rule.id,
      copyStatus: 'none',
    }

    /*
     * 验证码：`autoCopyCode` 可关，`rule.alwaysCopyCode` 可强制开
     * （决策表见 `features/05-verification-code.md § 2`）。
     */
    let toastStatus: 'copied' | 'failed' | 'manual' | null = null
    let copied = false

    if (codeMatch) {
      const autoCopy = shouldAutoCopyCode(app, rule)
      copied = autoCopy ? await copyWithTimeout(notifier, codeMatch.code) : false
      stored.copyStatus = autoCopy ? (copied ? 'copied' : 'failed') : 'none'
      toastStatus = autoCopy ? (copied ? 'copied' : 'failed') : 'manual'
    }

    /*
     * ⚠ **先入库、再通知**，顺序不能换：用户看到 toast → 点开 Popup 查这封邮件 →
     *   库里还没有 → 显示「找不到该邮件」。入库只要几毫秒，而 toast 的入场动画是 220ms。
     */
    await upsertMail(stored, retention)

    if (codeMatch && toastStatus) {
      await notifier.showToast({
        kind: 'code',
        mailId: stored.id,
        from: toastCaption(stored.from),
        code: codeMatch.code,
        status: toastStatus,
      })
    }

    notifier.notifyMailUpdated(stored.id)
    await notifier.updateBadge()
    return 'saved'
  }

  async function resolveRule(mail: Mail): Promise<PromptRule> {
    if (deps.ruleCache)
      return deps.ruleCache.for(mail)
    // 没给缓存时退化为「每次读一遍库」：正确但慢。生产路径由 background 传缓存。
    return pickRule(mail, await listRules())
  }

  return {
    async readSettingsForFilter() {
      const app = await readAppSettings()
      return { minimalMode: app.minimalMode, blockedEnabled: app.blockedEnabled }
    },

    async process(mail, account, retention) {
      const app = await readAppSettings()
      if (app.minimalMode)
        return processMinimal(mail, app)
      return processFull(mail, app, retention)
    },
  }
}

/**
 * 「再复制一次」成功之后回写状态。
 *
 * 放在这里（而不是让 content script 直接写库）：content script 没有必要具备 IDB
 * 访问路径 —— 它只该负责「在页面里执行 `writeText`」，把结果告诉 background 就结束。
 */
export async function recordManualCopy(mailId: string, ok: boolean): Promise<void> {
  await setCopyStatus(mailId, ok ? 'copied' : 'failed')
}
