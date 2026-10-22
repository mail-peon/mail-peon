import type { BuiltinMailTypeId, MailTypeAdapter, MailTypeUi } from '~/logic/types'
import { BUILTIN_CODE_ID, BUILTIN_CONFIRM_ID, BUILTIN_SUMMARY_ID } from '~/logic/types'

/**
 * 内置适配器目录（**代码是唯一真相，不落库**）。
 *
 * 与内置默认规则（`DEFAULT_RULE_ID`）同一套做法：用户改动只存 override，
 * 删掉 override 就恢复默认。这样：
 *   - 新版本加内置类型不需要写「播种」；
 *   - 清空数据后内置仍在；
 *   - 坏记录删掉即可恢复。
 *
 * ⚠ 内置提示词维护中英两套：基础 system 按浏览器语言选 ZH / EN，
 *   适配器段必须跟着同一个语言，否则模型会看到一段中文指令夹在英文模板里。
 */

export interface BuiltinAdapterDef {
  id: BuiltinMailTypeId
  ui: MailTypeUi
  /** UI 文案的 i18n key（`strings.ts`） */
  nameKey: string
  descriptionKey: string
  /** prompt 里的展示名（不经过 i18n，按输出语言选） */
  promptLabel: { zh: string, en: string }
  prompt: { zh: string, en: string }
  defaultPriority: number
  defaultFallback: boolean
  defaultEnabled: boolean
}

const CODE_PROMPT_ZH = `从邮件中找出一次性验证码 / OTP / 登录码。
- 只输出验证码本身：仅 [A-Za-z0-9]{4,12}，不要带「验证码是」等任何文字。
- 一封邮件可能有多个验证码：优先按用户补充规则选；没有规则时选与登录 / 验证动作最相关的那个；再否则取第一个。
- validForSeconds：只有邮件**明确写了时长**才输出，单位秒，只给数字。换算：1 分钟 = 60，1 小时 = 3600。
- expiresAt：只有邮件里出现明确的**绝对失效时间**（包括链接里的时间戳）才原样输出 ISO 8601。
- 两者都没有就省略。绝不用「常见值」猜（看到验证码就填 300 是错的）。`

const CODE_PROMPT_EN = `Find the one-time verification code / OTP / login code in the email.
- Output the code itself only: [A-Za-z0-9]{4,12}, without any surrounding words.
- If the email has several codes, follow the user's extra rules first; otherwise pick the one tied to the login / verification action; otherwise the first one.
- validForSeconds: output only when the email **explicitly states a duration**, in seconds, number only. 1 minute = 60, 1 hour = 3600.
- expiresAt: output only when the email contains an explicit **absolute expiry time** (including a timestamp inside the link), verbatim as ISO 8601.
- Omit both when absent. Never guess a "typical" value.`

const CONFIRM_PROMPT_ZH = `判断邮件是否是「确认 / 激活」类邮件：注册确认、邮箱验证、账号激活、一次性确认链接。
- 只输出**主操作链接**：从邮件正文或链接列表里原样复制；不要拼接、不要改写、不要猜。
- 忽略退订、隐私政策、社交账号、帮助中心等链接。
- label：按钮上的文案（如有），≤40 字；没有就省略。
- validForSeconds / expiresAt：与验证码同一套规则；链接里出现绝对过期时间时原样输出 ISO 8601。
- 找不到可用链接就不要输出这个类型。`

const CONFIRM_PROMPT_EN = `Decide whether the email is a confirmation / activation email: signup confirmation, email verification, account activation, one-time confirmation link.
- Output the **primary action link** only: copy it verbatim from the body or the link list. Never assemble, rewrite, or guess a URL.
- Ignore unsubscribe, privacy-policy, social, and help-center links.
- label: the button text if present, ≤40 chars; otherwise omit.
- validForSeconds / expiresAt: same rules as verification codes; copy an explicit absolute expiry from the link as ISO 8601.
- If there is no usable link, do not output this type.`

const SUMMARY_PROMPT_ZH = `只在**没有任何其它邮件类型命中**时输出这一段总结。
- minimal：一行 ≤60 字，浓缩主旨 + 关键动作（动词）。
- text：2-4 段，覆盖主旨 / 关键信息 / 需要用户做什么 / 链接（如有），≤600 字。
- 不要复述邮件里的客套话。`

const SUMMARY_PROMPT_EN = `Only produce this summary when **no other mail type matched**.
- minimal: one line ≤60 chars, distilling the gist + key action.
- text: 2-4 short paragraphs covering gist / key facts / what to do / links (if any), ≤600 chars.
- Skip pleasantries and boilerplate.`

export const BUILTIN_ADAPTERS: readonly BuiltinAdapterDef[] = [
  {
    id: BUILTIN_CODE_ID,
    ui: 'code',
    nameKey: 'adapters.code.name',
    descriptionKey: 'adapters.code.description',
    promptLabel: { zh: '验证码', en: 'Verification code' },
    prompt: { zh: CODE_PROMPT_ZH, en: CODE_PROMPT_EN },
    defaultPriority: 10,
    defaultFallback: false,
    defaultEnabled: true,
  },
  {
    id: BUILTIN_CONFIRM_ID,
    ui: 'confirm',
    nameKey: 'adapters.confirm.name',
    descriptionKey: 'adapters.confirm.description',
    promptLabel: { zh: '确认邮件', en: 'Confirmation email' },
    prompt: { zh: CONFIRM_PROMPT_ZH, en: CONFIRM_PROMPT_EN },
    defaultPriority: 20,
    defaultFallback: false,
    defaultEnabled: true,
  },
  {
    id: BUILTIN_SUMMARY_ID,
    ui: 'summary',
    nameKey: 'adapters.summary.name',
    descriptionKey: 'adapters.summary.description',
    promptLabel: { zh: '总结', en: 'Summary' },
    prompt: { zh: SUMMARY_PROMPT_ZH, en: SUMMARY_PROMPT_EN },
    defaultPriority: 999,
    defaultFallback: true,
    defaultEnabled: true,
  },
]

export function builtinAdapterDef(id: string): BuiltinAdapterDef | undefined {
  return BUILTIN_ADAPTERS.find(def => def.id === id)
}

/** 极简模式强制生效的两个内置类型 */
export const MINIMAL_MODE_ADAPTER_IDS: readonly string[] = [BUILTIN_CODE_ID, BUILTIN_CONFIRM_ID] as const

/** 默认状态下生效的适配器（用于「没有 override 时」的 UI / 提示词） */
export function defaultBuiltinAdapter(def: BuiltinAdapterDef): MailTypeAdapter {
  return {
    id: def.id,
    kind: 'builtin',
    ui: def.ui,
    name: def.promptLabel.zh,
    description: '',
    enabled: def.defaultEnabled,
    priority: def.defaultPriority,
    fallback: def.defaultFallback,
    prompt: def.prompt.zh,
  }
}
