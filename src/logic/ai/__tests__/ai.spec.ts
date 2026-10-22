import type { Mail, MailTypeAdapter } from '~/logic/types'
import { describe, expect, it } from 'vitest'
import { decodeHtmlEntities, extractLinks, htmlToText, normalizeMessageId, parseRawMail, toMail } from '~/adapters/mail/parser'
import { cleanCode, fallbackResult, heuristicCode, heuristicIsAd, parseAiResult, parseJsonLoose } from '~/logic/ai/output-schema'
import { looksLikeActionableEmail, looksLikeCodeEmail, matchedCodeHint } from '~/logic/ai/prefilter'
import {
  buildSystemPrompt,
  buildUserContent,
  EN_SYSTEM_PROMPT,
  MINIMAL_SYSTEM_PROMPT,
  truncateBody,
  ZH_SYSTEM_PROMPT,
} from '~/logic/ai/prompt-build'
import { resolveMailTypeAdapters } from '~/logic/mail-types/resolve'
import { senderLabel, toastCaption } from '~/logic/notification/copy'
import { badgeCount, mailKey, MailStateFlag, mailVisibility } from '~/logic/types'

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
    stateFlags: 0,
    messageId,
    ...patch,
  }
}

function fullAdapters(): MailTypeAdapter[] {
  return resolveMailTypeAdapters([], { minimalMode: false, lang: 'zh' })
}

function minimalAdapters(): MailTypeAdapter[] {
  return resolveMailTypeAdapters([], { minimalMode: true, lang: 'zh' })
}

function parseContext(mail: Mail = makeMail(), adapters: MailTypeAdapter[] = fullAdapters()) {
  return { adapters, mail }
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

  it('极简预筛放行「确认邮件」（否则最该看到的邮件会被丢掉）', () => {
    expect(looksLikeActionableEmail({
      subject: 'Please confirm your email address',
      bodyText: 'Click the button below to confirm.',
      snippet: '',
    })).toBe(true)
    expect(looksLikeActionableEmail({
      subject: '请确认你的邮箱',
      bodyText: '点击链接完成激活。',
      snippet: '',
    })).toBe(true)
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
    links: [],
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
    expect(mail.stateFlags).toBe(0)
  })

  it('links 落库（确认邮件只有 HTML 部分时靠它）', () => {
    const mail = toMail({ ...parsed, links: ['https://example.com/confirm'] }, { id: 'acc-1' })
    expect(mail.links).toEqual(['https://example.com/confirm'])
  })
})

describe('htmlToText / decodeHtmlEntities', () => {
  it('保留链接文字、剔除标签', () => {
    expect(htmlToText('<a href="https://x.com">点这里</a>')).toContain('点这里')
    expect(htmlToText('<a href="https://x.com">点这里</a>')).not.toContain('href')
  })

  it('extractLinks 同时抽 HTML href 与正文裸 URL', () => {
    const links = extractLinks(
      '<a href="https://example.com/confirm?a=1">点这里</a><a href="mailto:x@y.com">邮件</a>',
      '也可以直接打开 https://example.com/fallback 。',
    )
    expect(links).toContain('https://example.com/confirm?a=1')
    expect(links).toContain('https://example.com/fallback')
    expect(links.some(link => link.startsWith('mailto:'))).toBe(false)
  })

  it('extractLinks 挡掉 javascript: / data: 这类链接', () => {
    expect(extractLinks('<a href="javascript:alert(1)">x</a>', 'data:text/html,hi')).toEqual([])
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

describe('parseAiResult（多类型 + 状态位 + 兜底）', () => {
  it('接受多类型同时命中，并转出状态位', () => {
    const result = parseAiResult(JSON.stringify({
      types: [
        { adapterId: 'builtin:code', code: { value: '123456', validForSeconds: 300 } },
        { adapterId: 'builtin:confirm', confirm: { url: 'https://example.com/confirm/abc', label: 'Confirm' } },
      ],
      states: ['urgent'],
    }), parseContext())

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.result.output.types.map(match => match.kind)).toEqual(['code', 'confirm'])
      expect(result.result.output.code).toBe('123456')
      expect(result.result.stateFlags & MailStateFlag.Urgent).toBeTruthy()
    }
  })

  it('兜底：验证码命中时丢掉总结（需求 8）', () => {
    const result = parseAiResult(JSON.stringify({
      types: [
        { adapterId: 'builtin:code', code: { value: '123456' } },
        { adapterId: 'builtin:summary', summary: { minimal: '一行', text: '摘要' } },
      ],
      states: [],
    }), parseContext())

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.result.output.types.map(match => match.kind)).toEqual(['code'])
      expect(result.result.output.summary).toBeUndefined()
    }
  })

  it('没有任何非兜底命中时，总结仍在', () => {
    const result = parseAiResult(JSON.stringify({
      types: [
        { adapterId: 'builtin:summary', summary: { minimal: '一行', text: '摘要' } },
      ],
    }), parseContext())

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.result.output.types).toHaveLength(1)
      expect(result.result.output.summary).toBe('摘要')
    }
  })

  it('未知 / 未启用的 adapterId 被丢掉（防止模型幻觉）', () => {
    const result = parseAiResult(JSON.stringify({
      types: [
        { adapterId: 'custom:not-exist', custom: { text: '不该出现' } },
        { adapterId: 'builtin:code', code: { value: '123456' } },
      ],
    }), parseContext())

    expect(result.ok).toBe(true)
    if (result.ok)
      expect(result.result.output.types.map(match => match.kind)).toEqual(['code'])
  })

  it('非法验证码不会打掉整条结果，但该 match 被丢弃', () => {
    const result = parseAiResult(JSON.stringify({
      types: [
        { adapterId: 'builtin:code', code: { value: '1234567890123' } },
        { adapterId: 'builtin:summary', summary: { minimal: '一行', text: '摘要' } },
      ],
    }), parseContext())

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.result.output.code).toBeNull()
      // 验证码没命中 ⇒ 总结是唯一命中，保留
      expect(result.result.output.summary).toBe('摘要')
    }
  })

  it('被连字符 / 空格分组的验证码会被拼回去', () => {
    for (const value of ['123-456', '123 456']) {
      const result = parseAiResult(JSON.stringify({
        types: [{ adapterId: 'builtin:code', code: { value } }],
      }), parseContext())
      expect(result.ok).toBe(true)
      if (result.ok)
        expect(result.result.output.code).toBe('123456')
    }
  })

  it('确认链接只接受 http/https（挡掉 javascript:）', () => {
    const result = parseAiResult(JSON.stringify({
      types: [
        { adapterId: 'builtin:confirm', confirm: { url: 'javascript:alert(1)' } },
      ],
    }), parseContext())

    expect(result.ok).toBe(true)
    if (result.ok)
      expect(result.result.output.types).toHaveLength(0)
  })

  it('urgent / low 互斥：两个都给时只保留 urgent', () => {
    const result = parseAiResult(JSON.stringify({ types: [], states: ['urgent', 'low'] }), parseContext())
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.result.stateFlags & MailStateFlag.Urgent).toBeTruthy()
      expect(result.result.stateFlags & MailStateFlag.LowPriority).toBeFalsy()
    }
  })

  it('不是 JSON 时返回 ok:false 与原因（调用方据此重试 / 降级）', () => {
    const result = parseAiResult('模型说了一堆话但没给 JSON', parseContext())
    expect(result.ok).toBe(false)
    if (!result.ok)
      expect(result.error).toBeTruthy()
  })

  it('缺 types 字段是结构性错误（不能当成「没有命中」静默放过）', () => {
    const result = parseAiResult('{}', parseContext())
    expect(result.ok).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// 降级
// ---------------------------------------------------------------------------

describe('fallbackResult', () => {
  it('标记 degraded 并带上原因', () => {
    const result = fallbackResult(makeMail(), fullAdapters(), '网络超时')
    expect(result.output.degraded).toBe(true)
    expect(result.output.error).toBe('网络超时')
  })

  it('总结用「发件人：主题」+ 正文片段兜底（AI 挂了也要能看到邮件）', () => {
    const result = fallbackResult(
      makeMail({ subject: '你的订单已发货', snippet: '这是正文的开头' }),
      fullAdapters(),
      'boom',
    )
    const summary = result.output.types.find(match => match.kind === 'summary')
    expect(summary).toBeTruthy()
    if (summary?.kind === 'summary') {
      expect(summary.minimal).toContain('GitHub')
      expect(summary.minimal).toContain('你的订单已发货')
      expect(summary.text).toContain('这是正文的开头')
    }
  })

  it('无主题时不产生「undefined」这种字样', () => {
    const result = fallbackResult(makeMail({ subject: '' }), fullAdapters(), 'boom')
    const summary = result.output.types.find(match => match.kind === 'summary')
    if (summary?.kind === 'summary') {
      expect(summary.minimal).not.toContain('undefined')
      expect(summary.text).toContain('(无主题)')
    }
  })

  it('带 List-Unsubscribe 时降级也标广告位', () => {
    const result = fallbackResult(makeMail({ listUnsubscribe: '<mailto:x@y.com>' }), fullAdapters(), 'boom')
    expect(result.stateFlags & MailStateFlag.Ad).toBeTruthy()
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
  const base = { adapters: fullAdapters(), rule: null, settings, browserLang: zhBrowser, mode: 'full' as const }

  it('中文浏览器用中文模板，英文浏览器用英文模板', () => {
    expect(buildSystemPrompt({ ...base, browserLang: 'zh-CN' })).toContain(ZH_SYSTEM_PROMPT)
    expect(buildSystemPrompt({ ...base, browserLang: 'en-US' })).toContain(EN_SYSTEM_PROMPT)
  })

  it('auto-email 一律走英文模板 + 一句自适应指令（不做 JS 端语言检测）', () => {
    const prompt = buildSystemPrompt({
      ...base,
      settings: { ...settings, outputLanguage: 'auto-email' },
    })
    expect(prompt).toContain(EN_SYSTEM_PROMPT)
    expect(prompt).toContain('same language as the email')
  })

  it('非中文浏览器 + auto-browser 时带上「用 XX 语言回答」', () => {
    expect(buildSystemPrompt({ ...base, browserLang: 'ja-JP' })).toContain('Respond in ja-JP.')
  })

  it('system prompt 必须含 "JSON" 字样（DeepSeek 的硬要求，否则可能返回空对象）', () => {
    expect(ZH_SYSTEM_PROMPT.toLowerCase()).toContain('json')
    expect(EN_SYSTEM_PROMPT.toLowerCase()).toContain('json')
    expect(MINIMAL_SYSTEM_PROMPT.toLowerCase()).toContain('json')
  })

  it('适配器段带 id / 名称 / 提示词，并且排在基础模板之后', () => {
    const prompt = buildSystemPrompt(base)
    expect(prompt).toContain('[builtin:code]')
    expect(prompt).toContain('[builtin:confirm]')
    expect(prompt).toContain('[builtin:summary]')
    expect(prompt.indexOf(ZH_SYSTEM_PROMPT)).toBeLessThan(prompt.indexOf('[builtin:code]'))
  })

  it('用户规则拼在基础模板与适配器**之后**，并标注为「不违反 schema 才生效」', () => {
    const prompt = buildSystemPrompt({
      ...base,
      rule: { id: 'r1', name: 'GitHub 通知', prompt: '告诉我哪个仓库有新 PR' },
    })
    // 顺序：基础模板 → 适配器 → 用户规则
    expect(prompt.indexOf(ZH_SYSTEM_PROMPT)).toBeLessThan(prompt.indexOf('告诉我哪个仓库有新 PR'))
    expect(prompt.indexOf('[builtin:code]')).toBeLessThan(prompt.indexOf('告诉我哪个仓库有新 PR'))
    expect(prompt).toContain('GitHub 通知')
    expect(prompt).toContain('不违反上面的 JSON Schema')
  })

  it('内置默认规则不附加「当前规则」段', () => {
    const prompt = buildSystemPrompt({
      ...base,
      rule: { id: '__default__', name: '默认规则（内置）', prompt: '不该出现' },
    })
    expect(prompt).not.toContain('不该出现')
  })

  it('极简模式不吃用户规则，也不带总结适配器', () => {
    const prompt = buildSystemPrompt({
      ...base,
      adapters: minimalAdapters(),
      mode: 'minimal',
      rule: { id: 'r1', name: '规则', prompt: '不该出现' },
    })
    expect(prompt).toContain(MINIMAL_SYSTEM_PROMPT)
    expect(prompt).not.toContain('当前规则')
    expect(prompt).not.toContain('[builtin:summary]')
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

  it('用户消息里单独列出 Links（只有 HTML 的确认邮件靠它）', () => {
    const content = buildUserContent(makeMail({ links: ['https://example.com/confirm/abc'] }))
    expect(content).toContain('--- Links ---')
    expect(content).toContain('https://example.com/confirm/abc')
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
    const mail = makeMail({ stateFlags: MailStateFlag.Ad | MailStateFlag.LowPriority })
    expect(mailVisibility(mail, app)).toBe('ad')
  })

  it('广告 + 排除关闭 → normal（回到主列表）', () => {
    const mail = makeMail({ stateFlags: MailStateFlag.Ad | MailStateFlag.LowPriority })
    expect(mailVisibility(mail, { excludeAds: false })).toBe('normal')
  })

  it('有验证码 → code（优先级高于 normal）', () => {
    const mail = makeMail({ code: '123456' })
    expect(mailVisibility(mail, app)).toBe('code')
  })

  it('广告优先级高于验证码（营销邮件里的验证码不该进主列表 —— 但仍在「验证码」分区可查）', () => {
    const mail = makeMail({ stateFlags: MailStateFlag.Ad, code: '123456' })
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
    const ad = makeMail({ stateFlags: MailStateFlag.Ad | MailStateFlag.LowPriority })
    expect(badgeCount([ad], app)).toBe(0)
    // 关掉排除 → 回到计数
    expect(badgeCount([ad], { excludeAds: false })).toBe(1)
  })

  it('验证码：复制成功不计入，复制失败要计入（用户得手动复制）', () => {
    expect(badgeCount([makeMail({ code: '123456', copyStatus: 'copied' })], app)).toBe(0)
    expect(badgeCount([makeMail({ code: '123456', copyStatus: 'failed' })], app)).toBe(1)
    expect(badgeCount([makeMail({ code: '123456', copyStatus: 'none' })], app)).toBe(1)
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
