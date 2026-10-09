import type { RuleCache } from './rule-engine'
import type { Notifier, ToastPayload } from '~/logic/notification/types'
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
 *
 *   投 toast 要经 `tabs.sendMessage` 打到当前激活页的 content script，而
 *   **扩展自己的页面没有 content script**（设置页 / Popup / 商店页）。
 *   这时 `webext-bridge` 抛
 *   `TypeError: Cannot read properties of undefined (reading 'fingerprint')` ——
 *   而且它抛在**异步回调**里，调用方的 try/catch 拦不住，Chrome 会把它报成
 *   「Error in event handler」，看起来像 background 崩了。
 *
 *   投递本身还可能**永不返回**（目标 tab 存在但 content script 还没连上）。
 *
 * 所以这里的语义是「尽力投一次，投不到就算了」：
 * 调用方 await 它得到的是「投递已结束」，而不是「投递成功」。
 *
 * @param notifier 通知器
 * @param payload toast 内容
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
 *
 *   超时后不去取消原来的操作（`writeText` / `sendMessage` 都没法取消）——
 *   它可能稍后自己成功，但我们已经按失败处理、界面给「点击复制」按钮。
 *   这个偏差是**可接受**的：最坏情况用户多点一次，而不是收不到邮件。
 *
 * @param notifier 通知器
 * @param code 验证码
 * @returns 是否复制成功
 */
async function copyWithTimeout(notifier: Notifier, code: string): Promise<boolean> {
  try {
    const timeout = new Promise<false>((resolve) => {
      setTimeout(resolve, COPY_TIMEOUT_MS, false)
    })
    return await Promise.race([notifier.copyToClipboard(code), timeout])
  }
  catch (error) {
    /*
     * 复制抛错也**不该**让邮件丢失。
     *
     * 修之前它一路冒到 `mailbox.ts` 的 catch，那一封被记成 failed 且不入库 ——
     * 也就是说「剪贴板被拒绝」会导致用户**收不到验证码**，而这两件事本该无关。
     */
    console.warn('[mail-peon] 复制验证码失败（不影响入库）', error)
    return false
  }
}

/** 一轮同步里的 AI 并发上限（`features/02-ai-summary.md § 4`：默认 3） */
const AI_CONCURRENCY = 3

/**
 * 由「入库时刻 + 有效期秒数」算出验证码的失效时刻。
 *
 * ## 为什么基准是入库时刻，而不是邮件的 `Date:` 头
 *
 * 邮件里写的是「此验证码将在 5 分钟内有效」—— 这个 5 分钟**从发信时刻起算**。
 * 直觉上该用 `Date:` 头当基准，但两个现实问题让它不可靠：
 *
 *   1. `Date:` 是**发件人写的**，可以任意伪造，时区写错的邮件非常常见
 *      （`parser.ts` 里 `receivedAt` 的取值顺序就是因为这个才把 INTERNALDATE 排在前面）；
 *   2. 补拉历史邮件时，`receivedAt`（INTERNALDATE）反而更保守 ——
 *      我们是在**这一刻**才知道这封邮件的，用更早的时间当基准会让倒计时虚高。
 *
 * 权衡的结论：**以入库时刻为基准**。对「刚到的验证码邮件」它几乎与发信时刻同时
 * （正常投递延迟是秒级），而对补拉的旧邮件它会给出更保守（更容易显示「已失效」）
 * 的结果 —— 保守的那一侧才是安全的一侧。
 *
 * ## 为什么要 `clamp` 而不是简单相加
 *
 * 邮件可能被**重新处理**（用户改了规则、或重跑 AI），那时 `mail.receivedAt`
 * 还是原始值，而「现在」已经过去很久。简单相加会算出 `receivedAt + 300`
 * —— 一个**已经过去**的时刻，倒计时立刻显示失效（这没问题）；
 * 但如果 `receivedAt` 被某种途径设成了未来（时钟跳变、导入的数据），
 * 相加就会给出一个虚高的未来时刻。所以显式取 `min(入库时刻 + 有效期, 现在 + 有效期)`。
 *
 * @param mail 邮件（用它的 `receivedAt`）
 * @param validForSeconds AI 读到的有效期；`null` / 缺失表示邮件没写
 * @returns 失效时刻；没有明确有效期时 `undefined`（**不写**这个字段，UI 就不展示倒计时）
 */
export function deriveCodeExpiresAt(mail: Mail, validForSeconds: number | null | undefined): number | undefined {
  return deriveCodeExpiry(mail, validForSeconds).expiresAt
}

/**
 * 验证码有效期的**总秒数**（进度条的分母）。
 *
 * 与 `deriveCodeExpiresAt` 共用同一个校验：无效输入一律返回 `undefined`，
 * 于是 `codeExpiresAt` 与 `codeValidForSeconds` **要么都有、要么都没有**。
 *
 * ⚠ 「要么都有」这一点很重要：只存其中一个会让 UI 拿到半套数据 ——
 *   有失效时刻但没总时长 ⇒ 进度条只能瞎猜分母（就是真机上那个
 *   「每次打开都从 100% 开始」的 bug）；反过来则是永远算不出何时失效。
 *
 * @param validForSeconds AI 读到的有效期
 * @returns 正数秒数；无效时 `undefined`
 */
export function deriveCodeValidForSeconds(
  validForSeconds: number | null | undefined,
): number | undefined {
  if (typeof validForSeconds !== 'number' || !Number.isFinite(validForSeconds) || validForSeconds <= 0)
    return undefined
  return validForSeconds
}

/**
 * 一次算出失效时刻与总时长（内部用，保证两者同生同灭）。
 *
 * @param mail 邮件（用它的 `receivedAt`）
 * @param validForSeconds AI 读到的有效期
 */
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

export function createMailPipeline(deps: MailPipelineDeps): MailPipeline {
  const browserLang = deps.browserLang ?? 'zh-CN'
  const limiter = createLimiter(AI_CONCURRENCY)
  const { notifier } = deps

  async function processMinimal(mail: Mail, app: AppSettings): Promise<MailOutcome> {
    /*
     * 1. 预筛：不像有验证码的**直接丢弃**，连 AI 都不调。
     *
     * ⚠ 这一步是极简模式**省钱的关键**（`design/minimal-mode.md § 3.3`）。
     *   没有它，用户的每一封邮件都会烧一次 AI 调用 —— 而极简模式的用户通常
     *   在一个收验证码的邮箱里同时收着几百封通知邮件。
     */
    if (!looksLikeCodeEmail(mail)) {
      /*
       * ⚠ 被预筛丢掉时要**留下痕迹**。
       *
       *   这是整条链路上唯一「什么都不做、也没有任何输出」的分支，而它的
       *   假阴性代价极高（用户拿不到验证码）。不记日志的话，真机上遇到
       *   「明明收到了验证码邮件却什么都没发生」时完全无从下手 ——
       *   中继日志显示抓取成功、AI 也没被调用、界面也没有，
       *   而这三件事合起来**恰好等于**「被预筛丢了」，但看不出来。
       */
      console.warn(
        `[mail-peon] 预筛跳过（不像验证码邮件）：${mail.subject}`,
      )
      return 'skipped'
    }

    const settings = await readAiSettings()
    if (!settings.apiKey) {
      console.warn('[mail-peon] 极简模式需要 AI Key，但当前没有配置 —— 验证码邮件不会被处理')
      return 'skipped'
    }

    // 2. 极简 AI：只要 code 与有效期（输入 <200 token / 输出 <40 token）
    const extracted = await limiter.run(() => extractCodeOnly(mail, settings, {
      browserLang,
      onCall: deps.onAiCall,
    }))

    // 3. 没提到 → 丢弃。设计文档明确：不入库、不弹 toast
    if (!extracted) {
      console.warn(`[mail-peon] AI 未提取到验证码（已丢弃）：${mail.subject}`)
      return 'skipped'
    }

    const { code, validForSeconds } = extracted
    console.warn(
      `[mail-peon] 提取到验证码：${mail.subject} → ${code}`
      + `${validForSeconds ? `（有效期 ${validForSeconds}s）` : '（邮件未写有效期，不显示倒计时）'}`,
    )

    /*
     * 自动复制（`autoCopyCode` 在极简模式里也是一个**普通开关**，不再是恒 true）。
     *
     * ⚠ 关掉时不是「什么都不做」：验证码照旧提取、照旧入库，只是不写剪贴板，
     *   而 toast 给一个「点击复制」按钮（`status: 'manual'`）—— 与完整模式
     *   关掉自动复制时的行为一致（见 `processFull` 里的同一段）。
     *
     * ⚠ 走 `copyWithTimeout` 而不是直接 `await notifier.copyToClipboard(code)`。
     *
     *   真机故障：用户开着**设置页**时收到验证码邮件，而 content script 不会注入
     *   `chrome-extension://` 页面 —— `copyToClipboard` 里那个
     *   `sendMessage(…, { content-script, tabId })` **永远等不到响应**。
     *   而它的下一行就是 `upsertMail`，于是**邮件永远不入库**，
     *   日志停在「提取到验证码」、没有任何报错。
     *
     *   现在这个超时放在**业务层**（而不是只放在 `copyToClipboard` 的实现里）：
     *   剪贴板是锦上添花，**任何 notifier 实现都不该有能力阻塞入库**。
     *   把保证写在调用点上，将来换实现（offscreen document 等）也不会重犯。
     */
    const autoCopy = shouldAutoCopyCode(app, null)
    const copied = autoCopy ? await copyWithTimeout(notifier, code) : false
    const toastStatus: 'copied' | 'failed' | 'manual'
      = autoCopy ? (copied ? 'copied' : 'failed') : 'manual'

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
      codeExpiresAt: deriveCodeExpiresAt(mail, validForSeconds),
      // 进度条的分母（见 `codeValidForSeconds` 的说明）
      codeValidForSeconds: deriveCodeValidForSeconds(validForSeconds),
      ai: {
        minimal: `验证码：${code}`,
        summary: '',
        isAd: false,
        code,
        validForSeconds,
        urgency: 'high',
      },
      copyStatus: autoCopy ? (copied ? 'copied' : 'failed') : 'none',
    }

    // 极简模式写死 50 条（不暴露设置项）
    await upsertMail(minimalMail, MINIMAL_RETENTION)
    console.warn(`[mail-peon] 已入库：${minimalMail.id}`)

    /*
     * ⚠ toast 走 `notifySafe`，理由与上面的 `copyWithTimeout` **完全相同**：
     *
     *   投 toast 要经 `tabs.sendMessage` 打到当前激活页的 content script，而
     *   **扩展自己的页面（设置页 / Popup）没有 content script** ——
     *   这时 `webext-bridge` 会抛
     *   `TypeError: Cannot read properties of undefined (reading 'fingerprint')`，
     *   而且它抛在**异步回调**里，逃出 `sendMessage` 的 try/catch，
     *   被 Chrome 报成「Error in event handler」。
     *
     *   而这一句是 `await` 的 —— 一次投递失败就足以打断整封邮件的处理。
     *   toast 只是锦上添花：**邮件已经入库了，提示失败不该让它消失。**
     */
    await notifySafe(notifier, {
      kind: 'code',
      mailId: minimalMail.id,
      from: toastCaption(minimalMail.from),
      code,
      status: toastStatus,
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
      codeExpiresAt: deriveCodeExpiresAt(mail, resolved.validForSeconds),
      // 进度条的分母，理由见 `processMinimal` 里的同处注释
      codeValidForSeconds: deriveCodeValidForSeconds(resolved.validForSeconds),
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
 * 让 content script 也能写库，意味着两处都要维护 schema 归一化。
 */
export async function recordManualCopy(mailId: string, ok: boolean): Promise<void> {
  await setCopyStatus(mailId, ok ? 'copied' : 'failed')
}
