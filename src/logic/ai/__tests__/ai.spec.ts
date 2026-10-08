import type { Mail } from '~/logic/types'
import { describe, expect, it } from 'vitest'
import { decodeHtmlEntities, htmlToText, normalizeMessageId, parseRawMail, toMail } from '~/adapters/mail/parser'
import { cleanCode, fallbackOutput, heuristicCode, heuristicIsAd, parseAiOutput, parseJsonLoose } from '~/logic/ai/output-schema'
import { looksLikeCodeEmail, matchedCodeHint } from '~/logic/ai/prefilter'
import {
  buildMinimalSystemPrompt,
  buildSystemPrompt,
  buildUserContent,
  EN_SYSTEM_PROMPT,
  MINIMAL_SYSTEM_PROMPT,
  truncateBody,
  ZH_SYSTEM_PROMPT,
} from '~/logic/ai/prompt-build'
import { senderLabel, toastCaption } from '~/logic/notification/copy'
import { badgeCount, mailKey, mailVisibility } from '~/logic/types'

/**
 * AI 层与派生 UI 字段的单测（`03-roadmap.md` M2 验收 + `features/02 § 6.2` 的 badge 规则）。
 *
 * 三个最容易出错的点在这里被钉住：
 *   1. `cleanCode` —— 把「您的验证码是 123456」洗成 `123456`，同时**不能**把
 *      `"null"` 当成验证码复制进用户的剪贴板；
 *   2. `fallbackOutput` —— AI 挂了也要能看出这封邮件是什么（产品原则：可降级）；
 *   3. `badgeCount` —— 广告与已复制的验证码不计入，这条规则直接决定用户被打扰的频率。
 */

function makeMail(patch: Partial<Mail> = {}): Mail {
  const messageId = patch.messageId ?? 'm1'
  return {
    id: mailKey('acc-1', messageId),
    accountId: 'acc-1',
    from: [{ name: 'GitHub', address: 'noreply@github.com' }],
    to: [],
    subject: 'Hello',
    snippet: 'body preview',
    bodyText: 'body preview full',
    receivedAt: 1_700_000_000_000,
    processing: 'sent',
    copyStatus: 'none',
    read: false,
    messageId,
    ...patch,
  }
}

// ---------------------------------------------------------------------------
// 预筛（极简模式省钱的关键）
// ---------------------------------------------------------------------------

describe('looksLikeCodeEmail', () => {
  it('中文「验证码」命中', () => {
    expect(looksLikeCodeEmail({ subject: '您的验证码', bodyText: '', snippet: '' })).toBe(true)
  })

  it('英文 code / otp / verification code 命中', () => {
    expect(looksLikeCodeEmail({ subject: 'Your code', bodyText: '', snippet: '' })).toBe(true)
    expect(looksLikeCodeEmail({ subject: 'OTP for login', bodyText: '', snippet: '' })).toBe(true)
    expect(looksLikeCodeEmail({ subject: 'Your verification code', bodyText: '', snippet: '' })).toBe(true)
  })

  it('正文里的短数字串命中（4-8 位）', () => {
    expect(looksLikeCodeEmail({ subject: '', bodyText: '你的登录码 4821', snippet: '' })).toBe(true)
  })

  it('被空格 / 连字符分隔的数字串也命中（很多平台为可读性这么写）', () => {
    expect(looksLikeCodeEmail({ subject: '', bodyText: 'code 123 456', snippet: '' })).toBe(true)
  })

  it('日文 / 韩文命中（设计文档要求支持任何语言的邮件）', () => {
    expect(looksLikeCodeEmail({ subject: '確認コードのお知らせ', bodyText: '', snippet: '' })).toBe(true)
    expect(looksLikeCodeEmail({ subject: '인증번호 안내', bodyText: '', snippet: '' })).toBe(true)
  })

  it('普通邮件不命中（否则每封邮件都要白调一次 AI）', () => {
    expect(looksLikeCodeEmail({
      subject: 'Weekly newsletter',
      bodyText: 'Here is what happened this week in the world of software.',
      snippet: '',
    })).toBe(false)
  })

  it('只扫正文前 1000 字（底部的年份不该触发短数字串规则）', () => {
    const long = `${'a'.repeat(1200)}Copyright 2024 Example Inc.`
    expect(looksLikeCodeEmail({ subject: 'News', bodyText: long, snippet: '' })).toBe(false)
  })

  it('matchedCodeHint 指出命中的是哪条线索（诊断用）', () => {
    expect(matchedCodeHint({ subject: '验证码', bodyText: '', snippet: '' })).toContain('验')
    expect(matchedCodeHint({ subject: 'hi', bodyText: 'nothing here', snippet: '' })).toBeNull()
  })
})

describe('parseRawMail', () => {
  const raw = (text: string) => new TextEncoder().encode(text)

  it('解析出头部 / 正文 / messageId', async () => {
    const parsed = await parseRawMail(raw([
      'From: GitHub <noreply@github.com>',
      'To: me@example.com',
      'Subject: New PR',
      'Date: Wed, 15 Nov 2023 10:00:00 +0000',
      'Message-ID: <abc@example.com>',
      'MIME-Version: 1.0',
      'Content-Type: text/plain; charset=utf-8',
      '',
      'A new pull request.',
    ].join('\r\n')))

    expect(parsed.from).toEqual([{ name: 'GitHub', address: 'noreply@github.com' }])
    expect(parsed.subject).toBe('New PR')
    expect(parsed.text.trim()).toBe('A new pull request.')
    // 尖括号被摘掉 —— 不摘的话同一封邮件在两次同步里会算出两个账本键（重复入库）
    expect(parsed.messageId).toBe('abc@example.com')
    expect(parsed.date).toBe(Date.parse('Wed, 15 Nov 2023 10:00:00 +0000'))
  })

  it('messageId 归一：去掉尖括号', () => {
    expect(normalizeMessageId('<abc@host>')).toBe('abc@host')
    expect(normalizeMessageId('abc@host')).toBe('abc@host')
    expect(normalizeMessageId('')).toBeNull()
    expect(normalizeMessageId(undefined)).toBeNull()
  })

  it('没有 text 部分时从 HTML 退化出纯文本', async () => {
    const parsed = await parseRawMail(raw([
      'From: a@b.com',
      'Subject: html only',
      'MIME-Version: 1.0',
      'Content-Type: text/html; charset=utf-8',
      '',
      '<html><body><p>验证码 <b>123456</b></p><script>alert(1)</script></body></html>',
    ].join('\r\n')))

    // script 内容必须被剔除，否则 AI 会读到一堆 JS
    expect(parsed.text).toContain('123456')
    expect(parsed.text).not.toContain('alert')
  })

  it('空字节流不抛错（畸形邮件由 toMail 兜住，轮不到解析器崩）', async () => {
    const parsed = await parseRawMail(new Uint8Array(0))
    expect(parsed.subject).toBe('')
    expect(parsed.from).toEqual([])
  })
})

describe('toMail', () => {
  const parsed = {
    from: [{ name: '', address: 'a@b.com' }],
    to: [],
    cc: [],
    subject: 'S',
    text: 'body',
    html: '',
    date: 1000,
    messageId: 'mid',
    listUnsubscribe: null,
  }

  it('receivedAt 优先用 provider 给的服务器时间（Date 头是发件人写的，可伪造）', () => {
    const mail = toMail(parsed, { id: 'acc-1' }, { fallbackDate: 5000 })
    expect(mail.receivedAt).toBe(5000)
  })

  it('没有服务器时间时退回 Date 头', () => {
    expect(toMail(parsed, { id: 'acc-1' }).receivedAt).toBe(1000)
  })

  it('账本键是 <accountId>:<messageId>', () => {
    expect(toMail(parsed, { id: 'acc-1' }).id).toBe('acc-1:mid')
  })

  it('messageId 缺失时退化为 nanoid（且不同邮件不同键）', () => {
    const a = toMail({ ...parsed, messageId: null }, { id: 'acc-1' })
    const b = toMail({ ...parsed, messageId: null }, { id: 'acc-1' })
    expect(a.messageId).toBeTruthy()
    expect(a.id).not.toBe(b.id)
  })

  it('snippet 取前 240 字，bodyText 存全文', () => {
    const long = 'x'.repeat(500)
    const mail = toMail({ ...parsed, text: long }, { id: 'acc-1' })
    expect(mail.snippet.length).toBe(240)
    expect(mail.bodyText!.length).toBe(500)
  })

  it('不存 HTML（MVP 的隐私 + 体积取舍）', () => {
    expect(toMail({ ...parsed, html: '<p>x</p>' }, { id: 'acc-1' }).bodyHtml).toBeUndefined()
  })

  it('新邮件是 pending + 未读 + 未复制', () => {
    const mail = toMail(parsed, { id: 'acc-1' })
    expect(mail.processing).toBe('pending')
    expect(mail.read).toBe(false)
    expect(mail.copyStatus).toBe('none')
  })
})

describe('htmlToText / decodeHtmlEntities', () => {
  it('保留链接文字、剔除标签', () => {
    expect(htmlToText('<a href="https://x.com">点这里</a>')).toContain('点这里')
    expect(htmlToText('<a href="https://x.com">点这里</a>')).not.toContain('href')
  })

  it('注释与 head 被剔除', () => {
    expect(htmlToText('<!-- 隐藏 --><head><title>T</title></head><p>正文</p>')).not.toContain('隐藏')
    expect(htmlToText('<!-- 隐藏 --><head><title>T</title></head><p>正文</p>')).toContain('正文')
  })

  it('实体解码（命名 + 十进制 + 十六进制）', () => {
    expect(decodeHtmlEntities('a&amp;b&nbsp;c&#65;&#x42;')).toBe('a&b cAB')
  })

  it('未知实体原样保留（不猜）', () => {
    expect(decodeHtmlEntities('&notanentity;')).toBe('&notanentity;')
  })
})

// ---------------------------------------------------------------------------
// 输出清洗
// ---------------------------------------------------------------------------

describe('cleanCode', () => {
  it('纯 4-12 位字母数字原样保留', () => {
    expect(cleanCode('123456')).toBe('123456')
    expect(cleanCode('AB12CD')).toBe('AB12CD')
  })

  it('从「您的验证码是 123456」里抽出验证码', () => {
    expect(cleanCode('您的验证码是 123456')).toBe('123456')
  })

  it('处理被空格分隔的验证码', () => {
    expect(cleanCode('123 456')).toBe('123456')
  })

  it('把模型的「没有验证码」写法归一成 null（最要紧的一条）', () => {
    // 不处理的话，用户剪贴板里会出现字符串 "null"
    for (const value of ['null', 'NULL', 'none', 'nil', 'N/A', '无', 'undefined', '']) {
      expect(cleanCode(value)).toBeNull()
    }
  })

  it('纯字母候选里优先挑含数字的（纯字母多半是正文单词）', () => {
    expect(cleanCode('This is code AB12 for you')).toBe('AB12')
    // 没有含数字的候选 → 拒绝，而不是随便给一个单词
    expect(cleanCode('nothing here at all')).toBeNull()
  })

  it('长度超限或过短的都拒绝', () => {
    expect(cleanCode('123')).toBeNull()
    expect(cleanCode('1234567890123')).toBeNull()
  })

  it('非字符串输入返回 null', () => {
    expect(cleanCode(null)).toBeNull()
    expect(cleanCode(undefined)).toBeNull()
  })
})

describe('parseJsonLoose', () => {
  it('直接解析纯 JSON', () => {
    expect(parseJsonLoose('{"a":1}')).toEqual({ a: 1 })
  })

  it('剥掉 ```json 代码块（模型经常无视「不要围栏」的要求）', () => {
    expect(parseJsonLoose('```json\n{"a":1}\n```')).toEqual({ a: 1 })
    expect(parseJsonLoose('```\n{"a":1}\n```')).toEqual({ a: 1 })
  })

  it('从解释性文字里截出 JSON', () => {
    expect(parseJsonLoose('好的，这是结果：{"a":1} 希望有帮助')).toEqual({ a: 1 })
  })

  it('无法解析时抛错', () => {
    expect(() => parseJsonLoose('完全不是 JSON')).toThrow()
    expect(() => parseJsonLoose('')).toThrow()
  })
})

describe('parseAiOutput', () => {
  it('完整合法的输出被接受', () => {
    const result = parseAiOutput(JSON.stringify({
      minimal: '验证码：123456',
      summary: '一句话',
      isAd: false,
      code: '123456',
      urgency: 'high',
    }))
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.output.code).toBe('123456')
      expect(result.output.urgency).toBe('high')
    }
  })

  it('缺字段 / 类型不对时用安全默认兜住（不让整条记录掉进降级）', () => {
    const result = parseAiOutput(JSON.stringify({ minimal: 'x' }))
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.output.summary).toBe('')
      expect(result.output.isAd).toBe(false)
      expect(result.output.urgency).toBe('normal')
      expect(result.output.code).toBeNull()
    }
  })

  it('urgent 这种非法枚举值退回 normal', () => {
    const result = parseAiOutput(JSON.stringify({ minimal: 'x', urgency: 'URGENT' }))
    expect(result.ok).toBe(true)
    if (result.ok)
      expect(result.output.urgency).toBe('normal')
  })

  it('code 字段异常不会让整条记录降级（summary 仍然保留）', () => {
    /*
     * 提示词要求 `[A-Za-z0-9]{4,12}`，但 code 字段的 zod schema 刻意宽松：
     * 用一个字符串把整条记录打掉，会连本来完全可用的 summary 一起丢掉 ——
     * 而那正是用户最需要的那部分。
     */
    const tooLong = parseAiOutput(JSON.stringify({ minimal: 'x', summary: 'y', code: '1234567890123' }))
    expect(tooLong.ok).toBe(true)
    if (tooLong.ok) {
      expect(tooLong.output.summary).toBe('y')
      expect(tooLong.output.code).toBeNull()
    }

    const pureLetters = parseAiOutput(JSON.stringify({ minimal: 'x', summary: 'y', code: 'nothing here' }))
    expect(pureLetters.ok).toBe(true)
    if (pureLetters.ok) {
      expect(pureLetters.output.summary).toBe('y')
      // 纯字母候选一律拒绝：真实验证码几乎都含数字，纯字母多半是正文单词
      expect(pureLetters.output.code).toBeNull()
    }
  })

  it('被连字符 / 空格分组的验证码会被拼回去（很多平台为可读性这么写）', () => {
    const result = parseAiOutput(JSON.stringify({ minimal: 'x', summary: 'y', code: '123-456' }))
    expect(result.ok).toBe(true)
    if (result.ok)
      expect(result.output.code).toBe('123456')

    const spaced = parseAiOutput(JSON.stringify({ minimal: 'x', summary: 'y', code: '123 456' }))
    expect(spaced.ok).toBe(true)
    if (spaced.ok)
      expect(spaced.output.code).toBe('123456')
  })

  it('不是 JSON 时返回 ok:false 与原因（调用方据此重试 / 降级）', () => {
    const result = parseAiOutput('模型说了一堆话但没给 JSON')
    expect(result.ok).toBe(false)
    if (!result.ok)
      expect(result.error).toBeTruthy()
  })
})

// ---------------------------------------------------------------------------
// 降级
// ---------------------------------------------------------------------------

describe('fallbackOutput', () => {
  it('标记 degraded 并带上原因', () => {
    const output = fallbackOutput(makeMail(), '网络超时')
    expect(output.degraded).toBe(true)
    expect(output.error).toBe('网络超时')
  })

  it('minimal 用「发件人：主题」兜底（用户至少知道是谁发来的）', () => {
    const output = fallbackOutput(makeMail({ subject: '你的订单已发货' }), 'boom')
    expect(output.minimal).toContain('GitHub')
    expect(output.minimal).toContain('你的订单已发货')
  })

  it('summary 里带上邮件的正文片段（「AI 挂了也要能看到邮件」）', () => {
    const output = fallbackOutput(makeMail({ snippet: '这是正文的开头' }), 'boom')
    expect(output.summary).toContain('这是正文的开头')
  })

  it('urgency 不猜（一律 normal）', () => {
    expect(fallbackOutput(makeMail(), 'boom').urgency).toBe('normal')
  })

  it('无主题时不产生「undefined」这种字样', () => {
    const output = fallbackOutput(makeMail({ subject: '' }), 'boom')
    expect(output.minimal).not.toContain('undefined')
    expect(output.summary).toContain('(无主题)')
  })
})

describe('启发式', () => {
  it('带 List-Unsubscribe 视为广告（群发的可靠信号）', () => {
    expect(heuristicIsAd({ listUnsubscribe: '<mailto:x@y.com>' })).toBe(true)
    expect(heuristicIsAd({})).toBe(false)
  })

  it('从「验证码」关键词附近取数字', () => {
    expect(heuristicCode({ subject: '', snippet: '', bodyText: '您的验证码是 482913，5 分钟内有效' })).toBe('482913')
  })

  it('英文关键词同样有效', () => {
    expect(heuristicCode({ subject: '', snippet: '', bodyText: 'Your verification code is 90210.' })).toBe('90210')
  })

  it('主题里的独立数字串兜底', () => {
    expect(heuristicCode({ subject: '登录码 7788', snippet: '', bodyText: '' })).toBe('7788')
  })

  it('没有线索时返回 null，而不是从正文里闭眼抓一个数字', () => {
    // 正文里的订单号 / 金额 / 年份都是 4-8 位数字，闭眼抓会把剪贴板搞脏
    expect(heuristicCode({ subject: 'Order shipped', snippet: '', bodyText: 'Order #12345678 has shipped.' })).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// 提示词组装
// ---------------------------------------------------------------------------

describe('prompt-build', () => {
  const zhBrowser = 'zh-CN'
  const settings = { platform: 'openai', apiKey: 'k', outputLanguage: 'auto-browser' as const }

  it('中文浏览器用中文模板，英文浏览器用英文模板', () => {
    expect(buildSystemPrompt(null, settings, 'zh-CN')).toContain(ZH_SYSTEM_PROMPT)
    expect(buildSystemPrompt(null, settings, 'en-US')).toContain(EN_SYSTEM_PROMPT)
  })

  it('auto-email 一律走英文模板 + 一句自适应指令（不做 JS 端语言检测）', () => {
    const prompt = buildSystemPrompt(null, { ...settings, outputLanguage: 'auto-email' }, 'zh-CN')
    expect(prompt).toContain(EN_SYSTEM_PROMPT)
    expect(prompt).toContain('same language as the email')
  })

  it('非中文浏览器 + auto-browser 时带上「用 XX 语言回答」', () => {
    expect(buildSystemPrompt(null, settings, 'ja-JP')).toContain('Respond in ja-JP.')
  })

  it('system prompt 必须含 "JSON" 字样（DeepSeek 的硬要求，否则可能返回空对象）', () => {
    expect(ZH_SYSTEM_PROMPT.toLowerCase()).toContain('json')
    expect(EN_SYSTEM_PROMPT.toLowerCase()).toContain('json')
    expect(MINIMAL_SYSTEM_PROMPT.toLowerCase()).toContain('json')
  })

  it('用户规则拼在基础模板**之后**，并标注为「不违反 schema 才生效」', () => {
    const prompt = buildSystemPrompt(
      { id: 'r1', name: 'GitHub 通知', prompt: '告诉我哪个仓库有新 PR' },
      settings,
      zhBrowser,
    )
    // 顺序：基础模板在前，用户规则在后（放前面会被模型当成覆盖性指令）
    expect(prompt.indexOf(ZH_SYSTEM_PROMPT)).toBeLessThan(prompt.indexOf('告诉我哪个仓库有新 PR'))
    expect(prompt).toContain('GitHub 通知')
    expect(prompt).toContain('不违反上面的 JSON Schema')
  })

  it('内置默认规则不附加「当前规则」段', () => {
    const prompt = buildSystemPrompt(
      { id: '__default__', name: '默认规则（内置）', prompt: '不该出现' },
      settings,
      zhBrowser,
    )
    expect(prompt).not.toContain('不该出现')
  })

  it('极简模式不吃用户规则（极简模式没有多规则匹配这项能力）', () => {
    const prompt = buildMinimalSystemPrompt(settings, zhBrowser)
    expect(prompt).toContain(MINIMAL_SYSTEM_PROMPT)
    expect(prompt).not.toContain('当前规则')
  })

  it('截断标注原文长度（模型与用户都要知道这不是全文）', () => {
    const text = 'x'.repeat(100)
    const truncated = truncateBody(text, 10)
    expect(truncated.startsWith('x'.repeat(10))).toBe(true)
    expect(truncated).toContain('原文 100 字')
  })

  it('短正文不截断、不加标注', () => {
    expect(truncateBody('short', 10)).toBe('short')
  })

  it('用户消息里 List-Unsubscribe 单独列出（广告判定最可靠的单点信号）', () => {
    const content = buildUserContent(makeMail({ listUnsubscribe: '<mailto:u@x.com>' }))
    expect(content).toContain('List-Unsubscribe: <mailto:u@x.com>')
  })

  it('用户消息带齐 From / Subject / Date（判断性质最关键的三个信号）', () => {
    const content = buildUserContent(makeMail({ subject: '主题' }))
    expect(content).toContain('From: GitHub <noreply@github.com>')
    expect(content).toContain('Subject: 主题')
    expect(content).toContain('Date: ')
  })

  it('空正文时不产出空字符串正文段', () => {
    expect(buildUserContent(makeMail({ bodyText: undefined, snippet: '' }))).toContain('(正文为空)')
  })
})

// ---------------------------------------------------------------------------
// 派生 UI 字段
// ---------------------------------------------------------------------------

describe('mailVisibility', () => {
  const app = { excludeAds: true }

  it('aI 还没回 → pending', () => {
    expect(mailVisibility(makeMail({ processing: 'pending', ai: undefined }), app)).toBe('pending')
  })

  it('广告 + 排除开启 → ad', () => {
    const mail = makeMail({ ai: { minimal: '', summary: '', isAd: true, urgency: 'low' } })
    expect(mailVisibility(mail, app)).toBe('ad')
  })

  it('广告 + 排除关闭 → normal（回到主列表）', () => {
    const mail = makeMail({ ai: { minimal: '', summary: '', isAd: true, urgency: 'low' } })
    expect(mailVisibility(mail, { excludeAds: false })).toBe('normal')
  })

  it('有验证码 → code（优先级高于 normal）', () => {
    const mail = makeMail({ ai: { minimal: '', summary: '', isAd: false, code: '123456', urgency: 'normal' } })
    expect(mailVisibility(mail, app)).toBe('code')
  })

  it('广告优先级高于验证码（营销邮件里的验证码不该进主列表 —— 但仍在「验证码」分区可查）', () => {
    const mail = makeMail({ ai: { minimal: '', summary: '', isAd: true, code: '123456', urgency: 'low' } })
    expect(mailVisibility(mail, app)).toBe('ad')
  })
})

describe('badgeCount（features/02 § 6.2）', () => {
  const app = { excludeAds: true }

  it('普通未读邮件计入', () => {
    expect(badgeCount([makeMail()], app)).toBe(1)
  })

  it('已读 / 已 dismiss 的不计入', () => {
    expect(badgeCount([makeMail({ read: true })], app)).toBe(0)
    expect(badgeCount([makeMail({ dismissed: true })], app)).toBe(0)
  })

  it('aI 处理中的不计入（还没结果，打扰用户没意义）', () => {
    expect(badgeCount([makeMail({ processing: 'pending' })], app)).toBe(0)
  })

  it('广告不计入（开启排除时）', () => {
    const ad = makeMail({ ai: { minimal: '', summary: '', isAd: true, urgency: 'low' } })
    expect(badgeCount([ad], app)).toBe(0)
    // 关掉排除 → 回到计数
    expect(badgeCount([ad], { excludeAds: false })).toBe(1)
  })

  it('验证码：复制成功不计入，复制失败要计入（用户得手动复制）', () => {
    const ai = { minimal: '', summary: '', isAd: false, code: '123456', urgency: 'normal' as const }
    expect(badgeCount([makeMail({ ai, copyStatus: 'copied' })], app)).toBe(0)
    expect(badgeCount([makeMail({ ai, copyStatus: 'failed' })], app)).toBe(1)
    expect(badgeCount([makeMail({ ai, copyStatus: 'none' })], app)).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// 发件人展示
// ---------------------------------------------------------------------------

describe('发件人展示口径', () => {
  it('senderLabel 优先用显示名', () => {
    expect(senderLabel([{ name: 'GitHub', address: 'noreply@github.com' }])).toBe('GitHub')
  })

  it('senderLabel 没有显示名时用 @ 前部分', () => {
    expect(senderLabel([{ name: '', address: 'noreply@github.com' }])).toBe('noreply')
  })

  it('toastCaption 同时给显示名与地址（显示名会骗人，地址是用户能验证的）', () => {
    expect(toastCaption([{ name: 'GitHub', address: 'noreply@github.com' }]))
      .toBe('GitHub · noreply@github.com')
  })

  it('空发件人不产出「undefined」', () => {
    expect(senderLabel([])).toBe('(未知发件人)')
    expect(toastCaption([])).toBe('(未知发件人)')
  })
})
