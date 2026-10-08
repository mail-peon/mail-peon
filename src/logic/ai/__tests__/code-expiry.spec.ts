import type { Mail } from '~/logic/types'
import { describe, expect, it } from 'vitest'
import {
  cleanValidForSeconds,
  MAX_VALID_FOR_SECONDS,
  MIN_VALID_FOR_SECONDS,
  parseAiOutput,
} from '~/logic/ai/output-schema'
import { deriveCodeExpiresAt, deriveCodeValidForSeconds } from '~/logic/ai/pipeline'

/**
 * 验证码有效期的解析与换算。
 *
 * ## 这一组在防什么
 *
 * 「界面显示还有 5 分钟，而验证码早就失效了」比「不显示倒计时」糟得多 ——
 * 用户会照着那个倒计时去输验证码，然后失败，而且不知道原因。
 *
 * 所以这里的测试重点是**该丢的都丢掉**：模型猜的、模糊的、区间、
 * 时间点（而不是时长）、离谱的大数……全都要变成 `null`。
 * 「多显示一个准的」价值有限，「显示一个错的」代价很大 —— 取舍是刻意不对称的。
 */

/** 用真实邮件正文里的那句话当样本 */
const REAL_BODY = `尊敬的 jingxuan zhu (wu),

您的账户安全验证码是: 34949

此验证码将在 5 分钟内有效。

登入IP地址: 2001:49f0:d142:0:6ec::`

describe('cleanValidForSeconds：接受的形态', () => {
  it('纯秒数（模型照要求输出）', () => {
    expect(cleanValidForSeconds(300)).toBe(300)
    expect(cleanValidForSeconds('300')).toBe(300)
  })

  it('带「秒」后缀', () => {
    expect(cleanValidForSeconds('300s')).toBe(300)
    expect(cleanValidForSeconds('300 秒')).toBe(300)
    expect(cleanValidForSeconds('300 seconds')).toBe(300)
    expect(cleanValidForSeconds('300 sec')).toBe(300)
  })

  /*
   * ⚠ 这一组防的是「英文缩写被当成秒」。
   *
   *   `min` / `h` 开头的后缀与「秒」族不重叠，但最初的规则用的是宽松的 `[a-z]*`，
   *   于是 `5 min` 被匹配成「数字 5 + 后缀 min」，后缀被丢掉、`5` 当成 5 **秒**。
   *   真实影响：倒计时显示 `0:05` 而不是 `5:00` —— 用户会以为验证码快失效了。
   */
  it('英文缩写按分钟/小时算，不能被当成秒', () => {
    expect(cleanValidForSeconds('5 min')).toBe(300)
    expect(cleanValidForSeconds('5min')).toBe(300)
    expect(cleanValidForSeconds('2h')).toBe(7200)
    expect(cleanValidForSeconds('1 hour')).toBe(3600)
  })

  it('分钟：真实邮件里的「5 分钟」', () => {
    expect(cleanValidForSeconds('5 分钟')).toBe(300)
    expect(cleanValidForSeconds('5分钟')).toBe(300)
    expect(cleanValidForSeconds('5min')).toBe(300)
    expect(cleanValidForSeconds('5 minutes')).toBe(300)
    expect(cleanValidForSeconds('10 分')).toBe(600)
  })

  it('小时', () => {
    expect(cleanValidForSeconds('1 小时')).toBe(3600)
    expect(cleanValidForSeconds('2h')).toBe(3600 * 2)
    expect(cleanValidForSeconds('1 hour')).toBe(3600)
  })

  it('小数秒数四舍五入', () => {
    expect(cleanValidForSeconds(300.4)).toBe(300)
    expect(cleanValidForSeconds('300.6')).toBe(301)
  })
})

describe('cleanValidForSeconds：该丢的形态', () => {
  /*
   * ⚠ 这些是**最重要**的断言。
   *
   * 提示词里明确要求「邮件没写有效期就 null，不要猜」—— 但模型经常不听。
   * 这里是最后一道防线：读不到就丢，绝不填默认值。
   */
  it('没有信息 → null', () => {
    expect(cleanValidForSeconds(null)).toBeNull()
    expect(cleanValidForSeconds(undefined)).toBeNull()
    expect(cleanValidForSeconds('')).toBeNull()
    expect(cleanValidForSeconds('   ')).toBeNull()
  })

  it('模型把「没有」写成字符串 → null', () => {
    for (const value of ['null', 'none', 'nil', 'n/a', 'na', '无', '没有', 'unknown', 'undefined', 'false'])
      expect(cleanValidForSeconds(value), value).toBeNull()
  })

  it('模糊说法 → null（不是数字，本来就解析不出）', () => {
    for (const value of ['请尽快使用', '短时间内有效', '立即使用', 'soon', 'short'])
      expect(cleanValidForSeconds(value), value).toBeNull()
  })

  it('时间点（而不是时长）→ null', () => {
    /*
     * ⚠ 这是最容易被误判的一类：「有效期至 14:30」里有个 14，
     *   模型可能会把它当小时数输出。兜住它的方式是不接受 `点/时:分` 这种形态。
     *   （`14:30` 在下面会走到「含冒号、不匹配任何模式」的分支 → null。）
     */
    expect(cleanValidForSeconds('14:30')).toBeNull()
    expect(cleanValidForSeconds('有效期至 14:30')).toBeNull()
  })

  it('区间 → null（取哪一端都不对）', () => {
    expect(cleanValidForSeconds('5-10 分钟')).toBeNull()
    expect(cleanValidForSeconds('5~10')).toBeNull()
  })

  it('0 与负数 → null（不是「立刻失效」，而是「没读到」）', () => {
    expect(cleanValidForSeconds(0)).toBeNull()
    expect(cleanValidForSeconds(-60)).toBeNull()
    expect(cleanValidForSeconds('0')).toBeNull()
  })

  it('小于下限 → null', () => {
    expect(cleanValidForSeconds(MIN_VALID_FOR_SECONDS - 1)).toBeNull()
    expect(cleanValidForSeconds(MIN_VALID_FOR_SECONDS)).toBe(MIN_VALID_FOR_SECONDS)
  })

  it('大于上限 → null（把「7 天内发货」当有效期是最典型的误判）', () => {
    expect(cleanValidForSeconds(MAX_VALID_FOR_SECONDS + 1)).toBeNull()
    expect(cleanValidForSeconds('7 天')).toBeNull() // 「天」不在支持的单位里
    expect(cleanValidForSeconds(24 * 3600)).toBe(MAX_VALID_FOR_SECONDS)
  })

  it('naN / Infinity / 非字符串非数字 → null', () => {
    expect(cleanValidForSeconds(Number.NaN)).toBeNull()
    expect(cleanValidForSeconds(Number.POSITIVE_INFINITY)).toBeNull()
    expect(cleanValidForSeconds({})).toBeNull()
    expect(cleanValidForSeconds([])).toBeNull()
    expect(cleanValidForSeconds(true)).toBeNull()
  })
})

describe('toAiOutput 把有效期装配进 AiOutput', () => {
  /*
   * ⚠ `parseAiOutput` 收的是**模型的原始文本**（字符串），不是对象 ——
   *   它内部要处理代码块围栏、多余说明这些真实形态。传对象进去会在
   *   `text.trim()` 上炸（而且报错位置指向 schema，看不出真正原因）。
   *   所以这里统一用 `JSON.stringify` 造输入，与真实调用一致。
   *
   * 返回值也是 discriminated union（`{ ok: true, output }` / `{ ok: false, error }`），
   * 不是 `AiOutput | null`。
   */
  function parse(payload: Record<string, unknown>): ReturnType<typeof parseAiOutput> {
    return parseAiOutput(JSON.stringify(payload))
  }

  it('正常提取（AI 给「5 分钟」，装配成 300 秒）', () => {
    const result = parse({
      minimal: '验证码：34949',
      summary: '',
      isAd: false,
      code: '34949',
      validForSeconds: '5 分钟',
      urgency: 'high',
    })

    expect(result.ok).toBe(true)
    if (!result.ok)
      throw new Error(result.error)

    expect(result.output.code).toBe('34949')
    expect(result.output.validForSeconds).toBe(300)
  })

  it('字段缺失时给 null（而不是 undefined）', () => {
    const result = parse({
      minimal: 'x',
      summary: '',
      isAd: false,
      code: null,
      urgency: 'normal',
    })

    expect(result.ok).toBe(true)
    if (!result.ok)
      throw new Error(result.error)

    expect(result.output.validForSeconds).toBeNull()
    expect(result.output.code).toBeNull()
  })
})

/**
 * 造一封最小可用的邮件。
 *
 * ⚠ 放在**模块作用域**而不是某个 `describe` 里：多个 describe 都要用它，
 *   嵌在其中一个里面会让别的 describe 报 `ReferenceError: mail is not defined`
 *   —— 那个错误看起来像「忘了 import」，其实是作用域问题。
 */
function mail(patch: Partial<Mail> = {}): Mail {
  return {
    id: 'm1',
    accountId: 'a1',
    from: [],
    to: [],
    subject: 's',
    snippet: '',
    receivedAt: Date.now(),
    processing: 'sent',
    copyStatus: 'none',
    read: false,
    ...patch,
  }
}

describe('deriveCodeExpiresAt：把相对秒数换算成绝对时刻', () => {
  it('入库时刻 + 有效期', () => {
    const receivedAt = 1_700_000_000_000
    expect(deriveCodeExpiresAt(mail({ receivedAt }), 300)).toBe(receivedAt + 300_000)
  })

  it('没有有效期 → undefined（**不写**这个字段，UI 就不展示倒计时）', () => {
    expect(deriveCodeExpiresAt(mail(), null)).toBeUndefined()
    expect(deriveCodeExpiresAt(mail(), undefined)).toBeUndefined()
  })

  it('非正数 / 非有限数 → undefined', () => {
    expect(deriveCodeExpiresAt(mail(), 0)).toBeUndefined()
    expect(deriveCodeExpiresAt(mail(), -5)).toBeUndefined()
    expect(deriveCodeExpiresAt(mail(), Number.NaN)).toBeUndefined()
    expect(deriveCodeExpiresAt(mail(), Number.POSITIVE_INFINITY)).toBeUndefined()
  })

  /*
   * ⚠ 这一条防的是「补拉历史邮件」那个场景。
   *
   * 用户第一次同步（或重置游标后）会拉到一批**几天前的**验证码邮件。
   * 如果直接算 `receivedAt + 5 分钟`，会得到一个**已经过去**的时刻 ——
   * 那没问题（倒计时立刻显示失效，诚实）。
   *
   * 但如果 `receivedAt` 因为时钟跳变 / 导入数据而落在**未来**，
   * 相加就会给出一个虚高的未来时刻，用户会看到「还有 5 分钟」而实际早失效了。
   * 所以基准要取 `min(receivedAt, now)`。
   */
  it('receivedAt 在未来时被钳制到现在（避免虚高的倒计时）', () => {
    const future = Date.now() + 10 * 24 * 3600 * 1000
    const expiresAt = deriveCodeExpiresAt(mail({ receivedAt: future }), 300)

    expect(expiresAt).toBeDefined()
    // 不能超过「现在 + 有效期」
    expect(expiresAt!).toBeLessThanOrEqual(Date.now() + 300_000 + 1000)
  })

  it('旧邮件的有效期已经过去（倒计时会立刻显示失效）', () => {
    const threeDaysAgo = Date.now() - 3 * 24 * 3600 * 1000
    expect(deriveCodeExpiresAt(mail({ receivedAt: threeDaysAgo }), 300)!).toBeLessThan(Date.now())
  })
})

describe('deriveCodeValidForSeconds：进度条的分母', () => {
  /*
   * ⚠ 真机 bug：进度条**每次打开 Popup 都从 100% 重新往下降**。
   *
   *   原因是只存了失效时刻、没存总时长，组件只好拿「挂载那一刻的剩余量」
   *   当分母 —— 于是它表达的是「这次打开后过了多久」，
   *   而不是「还剩多少」。
   *
   *   修法：把总时长也存下来，让「剩余 / 总时长」这个比例只由**现在**决定 ——
   *   同一时刻打开多少次，进度条都在同一个位置。
   */
  it('有效的秒数原样返回', () => {
    expect(deriveCodeValidForSeconds(300)).toBe(300)
    expect(deriveCodeValidForSeconds(60)).toBe(60)
  })

  it('无效输入 → undefined（与失效时刻**同生同灭**）', () => {
    expect(deriveCodeValidForSeconds(null)).toBeUndefined()
    expect(deriveCodeValidForSeconds(undefined)).toBeUndefined()
    expect(deriveCodeValidForSeconds(0)).toBeUndefined()
    expect(deriveCodeValidForSeconds(-60)).toBeUndefined()
    expect(deriveCodeValidForSeconds(Number.NaN)).toBeUndefined()
    expect(deriveCodeValidForSeconds(Number.POSITIVE_INFINITY)).toBeUndefined()
  })

  it('两个字段要么都有、要么都没有（半套数据会让进度条瞎猜分母）', () => {
    const receivedAt = Date.now()

    expect(deriveCodeExpiresAt(mail({ receivedAt }), 300)).toBeTypeOf('number')
    expect(deriveCodeValidForSeconds(300)).toBeTypeOf('number')

    expect(deriveCodeExpiresAt(mail({ receivedAt }), null)).toBeUndefined()
    expect(deriveCodeValidForSeconds(null)).toBeUndefined()
  })
})

describe('真实邮件样本', () => {
  /*
   * 用用户实际收到的那封邮件当回归样本 —— 它的措辞（「此验证码将在 5 分钟内有效。」）
   * 比我们自己编的样本更接近现实。
   */
  it('正文里的「5 分钟」被正确识别', () => {
    expect(REAL_BODY).toContain('5 分钟内有效')
    expect(cleanValidForSeconds('5 分钟')).toBe(300)
  })

  /*
   * ⚠ **边界测试**：确认代码不去正文里扫时间。
   *
   * 这是产品要求，不是实现细节：「有效期只能由 AI 读出来」。
   *   正则分不清「验证码 5 分钟内有效」与「订单 5 分钟内发货」，而 AI 读得懂上下文。
   *
   * 所以这一段故意喂一段**满是时长表述但 AI 没给出 validForSeconds** 的正文，
   * 断言没有任何「从正文推断」的入口存在。
   *
   * 做法：`parseAiOutput` 的输入是**模型的原始文本**，不是邮件正文 ——
   * 把邮件正文原样喂进去必须得到 `validForSeconds: null`，
   * 证明这个模块对正文内容一无所知。
   */
  it('把邮件正文当成模型输出喂进去 → 拿不到有效期（代码不读正文）', () => {
    const result = parseAiOutput(REAL_BODY)

    // 正文不是合法 JSON，应当走 schema 失败分支 —— 而不是「从中提取出 300」
    expect(result.ok).toBe(false)
  })

  it('正文里出现多个时长时，代码不做任何选择（因为没有输入）', () => {
    const noisyBody = '订单将在 5 分钟内发货。优惠券 30 天内有效。登录验证码 10 分钟内有效。'
    const result = parseAiOutput(noisyBody)

    expect(result.ok).toBe(false)
  })
})
