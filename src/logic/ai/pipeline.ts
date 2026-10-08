import type { RuleCache } from './rule-engine'
import type { Notifier } from '~/logic/notification/types'
import type { AiOutput, AppSettings, Mail, MailAccount, MailRetention, PromptRule } from '~/logic/types'
import { toastCaption } from '~/logic/notification/copy'
import { resolveIsAd, shouldAutoCopyCode } from '~/logic/rules/matcher'
import { setCopyStatus, upsertMail } from '~/logic/store/mails'
import { listRules } from '~/logic/store/rules'
import { readAiSettings, readAppSettings } from '~/logic/store/settings'
import { DEFAULT_RULE_ID, MINIMAL_RETENTION } from '~/logic/types'
import { looksLikeCodeEmail } from './prefilter'
import { createLimiter } from './queue'
import { pickRule } from './rule-engine'
import { extractCodeOnly, summarize } from './summarize'

/**
 * 邮件处理流水线 —— `adapters/mail/mailbox.ts` 与业务逻辑之间的那层。
 *
 * 存在的理由：`mailbox.ts` 只该关心「怎么把邮件从服务器拿下来」，它**不该知道**
 * 极简 / 完整模式的区别、AI 怎么调、验证码怎么复制。把那些收在这个接口的实现里
 * 之后，同步编排可以用一个假 pipeline 跑完单测 —— 不需要网络、AI、真邮箱。
 *
 * 两种模式的分支就在这里分开（`design/minimal-mode.md § 3.2`）：
 *
 *   极简：预筛 → 提取 code → 自动复制 → toast → **只写最小记录**（没 code 完全不入库）
 *   完整：挑规则 → AI → 落库 → badge / toast
 *   （排除邮箱的过滤在编排层做：它需要 `from`，而那要等解析完才知道）
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

/** 一轮同步里的 AI 并发上限（`features/02-ai-summary.md § 4`：默认 3） */
const AI_CONCURRENCY = 3

export function createMailPipeline(deps: MailPipelineDeps): MailPipeline {
  const browserLang = deps.browserLang ?? 'zh-CN'
  const limiter = createLimiter(AI_CONCURRENCY)
  const { notifier } = deps

  async function processMinimal(mail: Mail): Promise<MailOutcome> {
    /*
     * 1. 预筛：不像有验证码的**直接丢弃**，连 AI 都不调。
     *
     * ⚠ 这一步是极简模式**省钱的关键**（`design/minimal-mode.md § 3.3`）。
     *   没有它，用户的每一封邮件都会烧一次 AI 调用 —— 而极简模式的用户通常
     *   在一个收验证码的邮箱里同时收着几百封通知邮件。
     */
    if (!looksLikeCodeEmail(mail))
      return 'skipped'

    const settings = await readAiSettings()

    // 2. 极简 AI：只要 code（输入 <200 token / 输出 <30 token）
    const code = await limiter.run(() => extractCodeOnly(mail, settings, {
      browserLang,
      onCall: deps.onAiCall,
    }))

    // 3. 没提到 → 丢弃。设计文档明确：不入库、不弹 toast
    if (!code)
      return 'skipped'

    // 4. 自动复制（极简模式恒为 true，见 `shouldAutoCopyCode`）
    const copied = await notifier.copyToClipboard(code)

    /*
     * 极简模式的记录是**瘦身**的（`design/minimal-mode.md § 3.2`）：正文根本不存。
     * 用同一个 `Mail` 表、未用字段留空 —— 不引入第二套 schema（不这么做的话，
     * 「用户在两种模式间切换」就会面对两套表、两套查询、两套迁移）。
     */
    const minimalMail: Mail = {
      ...mail,
      snippet: '',
      bodyText: undefined,
      bodyHtml: undefined,
      processing: 'skipped',
      // 顶层 `code` 是极简模式的判据（见 `Mail.code` 的说明：UI 与 badge 用便宜的判据）
      code,
      ai: {
        minimal: `验证码：${code}`,
        summary: '',
        isAd: false,
        code,
        urgency: 'high',
      },
      copyStatus: copied ? 'copied' : 'failed',
    }

    // 极简模式写死 50 条（不暴露设置项）
    await upsertMail(minimalMail, MINIMAL_RETENTION)

    await notifier.showToast({
      kind: 'code',
      mailId: minimalMail.id,
      from: toastCaption(minimalMail.from),
      code,
      status: copied ? 'copied' : 'failed',
    })

    notifier.notifyMailUpdated(minimalMail.id)
    return 'saved'
  }

  async function processFull(mail: Mail, app: AppSettings, retention?: MailRetention): Promise<MailOutcome> {
    const [settings, rule] = await Promise.all([
      readAiSettings(),
      resolveRule(mail),
    ])

    const ai = await limiter.run(() => summarize(mail, rule, settings, {
      browserLang,
      onCall: deps.onAiCall,
    }))

    /*
     * 广告判定是「AI 输出 + 规则覆盖」的合成结果，**不是** AI 的原始 isAd：
     * 用户的 `alwaysSkipAd` 必须能推翻 AI（`features/04-exclude-ads.md § 3`）。
     */
    const resolved: AiOutput = { ...ai, isAd: resolveIsAd(ai.isAd, rule) }

    const stored: Mail = {
      ...mail,
      processing: 'sent',
      ai: resolved,
      ruleId: rule.id === DEFAULT_RULE_ID ? undefined : rule.id,
      copyStatus: 'none',
    }

    /*
     * 验证码：完整模式下 `autoCopyCode` 可关，`rule.alwaysCopyCode` 可强制开
     * （决策表见 `features/05-verification-code.md § 2`）。
     */
    let toastStatus: 'copied' | 'failed' | 'manual' | null = null
    let copied = false

    if (resolved.code) {
      const autoCopy = shouldAutoCopyCode(app, rule)
      copied = autoCopy ? await notifier.copyToClipboard(resolved.code) : false
      stored.copyStatus = autoCopy ? (copied ? 'copied' : 'failed') : 'none'
      // 关掉自动复制时是 'manual'：toast 上给「点击复制」按钮，而不是报「失败了」
      toastStatus = autoCopy ? (copied ? 'copied' : 'failed') : 'manual'
    }

    /*
     * ⚠ **先入库、再通知**，顺序不能换。
     *
     * 反过来的话，用户看到 toast → 点开 Popup 查这封邮件 → 库里还没有 → 显示
     * 「找不到该邮件」。入库只要几毫秒，而 toast 的入场动画是 220ms ——
     * 这个窗口在真机上肉眼可见。
     */
    await upsertMail(stored, retention)

    if (resolved.code && toastStatus) {
      await notifier.showToast({
        kind: 'code',
        mailId: stored.id,
        from: toastCaption(stored.from),
        code: resolved.code,
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
        return processMinimal(mail)
      return processFull(mail, app, retention)
    },
  }
}

/**
 * 「再复制一次」成功之后回写状态。
 *
 * 放在这里（而不是让 content script 直接写库）：content script 没有必要具备 IDB
 * 访问路径 —— 它只该负责「在页面里执行 `writeText`」，把结果告诉 background 就结束。
 * 让 content script 也能写库，意味着两处都要维护 schema 归一化。
 */
export async function recordManualCopy(mailId: string, ok: boolean): Promise<void> {
  await setCopyStatus(mailId, ok ? 'copied' : 'failed')
}
