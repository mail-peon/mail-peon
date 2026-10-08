import { describe, expect, it } from 'vitest'
import {
  hasNoCursor,
  mergeDefaults,
  normalizeAccount,
  normalizeAiSettings,
  normalizeAppSettings,
  normalizeBlockedList,
  normalizeCursor,
  normalizeMail,
  normalizeMatchers,
  normalizeRetention,
  normalizeRule,
  parseBlockedListText,
} from '~/logic/store/migrations'

/**
 * 归一化纯函数的单测。
 *
 * 这一层值得测的原因是：它是**唯一**读存量数据的地方，而存量数据的形状不可控
 * （旧版本写的、被 JSON 字符串化过的、字段缺失的、多出未知字段的）。
 * 归一化写错的表现不是崩溃，而是「某个字段悄悄变成了 undefined」——
 * 在 UI 上看起来只是「这里怎么空了」，极难追到根因。
 */

describe('mergeDefaults', () => {
  it('补齐 fallback 声明过的键', () => {
    expect(mergeDefaults({ a: 1 }, { a: 0, b: 2 })).toEqual({ a: 1, b: 2 })
  })

  it('丢弃 fallback 里没有的键（模型删了字段，存量数据不该把它带回来）', () => {
    expect(mergeDefaults({ a: 1, legacy: 'x' }, { a: 0 })).toEqual({ a: 1 })
  })

  it('按默认值的类型掰正原始值', () => {
    // 数字字符串 → 数字；`'true'` → true
    expect(mergeDefaults({ n: '42', b: 'true' }, { n: 0, b: false }))
      .toEqual({ n: 42, b: true })
    // 类型明显不对时退回默认值，而不是 `String(7)` —— 后者会把一个「本来就不是
    // 字符串」的脏数据变成看起来合法的 `'7'`，让问题在更晚的地方才暴露
    expect(mergeDefaults({ s: 7 }, { s: '' })).toEqual({ s: '' })
  })

  it('复活被 JSON 字符串化过的对象（早期 useWebExtensionStorage 的写法）', () => {
    expect(mergeDefaults('{"a":1}', { a: 0 })).toEqual({ a: 1 })
  })

  it('嵌套对象递归合并', () => {
    expect(mergeDefaults({ nested: { x: 1 } }, { nested: { x: 0, y: 2 } }))
      .toEqual({ nested: { x: 1, y: 2 } })
  })

  it('原始值不是对象时退回默认值', () => {
    expect(mergeDefaults(null, { a: 1 })).toEqual({ a: 1 })
    expect(mergeDefaults('garbage', { a: 1 })).toEqual({ a: 1 })
    expect(mergeDefaults([1, 2], { a: 1 })).toEqual({ a: 1 })
  })
})

describe('normalizeMatchers', () => {
  it('字符串形态：含 @ 当邮箱，否则当域名', () => {
    expect(normalizeMatchers(['me@a.com', 'github.com'])).toEqual([
      { kind: 'email', value: 'me@a.com' },
      { kind: 'domain', value: 'github.com' },
    ])
  })

  it('域名前的 @ 会被摘掉（用户就是这么写的）', () => {
    expect(normalizeMatchers([{ kind: 'domain', value: '@github.com' }]))
      .toEqual([{ kind: 'domain', value: 'github.com' }])
  })

  it('去重（同一个匹配写两遍会让 UI 上看起来「没生效」）', () => {
    expect(normalizeMatchers(['@github.com', 'github.com', { kind: 'domain', value: 'github.com' }]))
      .toEqual([{ kind: 'domain', value: 'github.com' }])
  })

  it('地址统一小写', () => {
    expect(normalizeMatchers(['Me@Example.COM'])).toEqual([{ kind: 'email', value: 'me@example.com' }])
  })

  it('未知 kind 退回 domain，空值丢弃', () => {
    expect(normalizeMatchers([{ kind: 'bogus', value: 'a.com' }, { value: '  ' }, null, 42]))
      .toEqual([{ kind: 'domain', value: 'a.com' }])
  })
})

describe('normalizeBlockedList', () => {
  it('只留 email / domain（屏蔽列表没有正则）', () => {
    expect(normalizeBlockedList([
      { kind: 'email', value: 'a@b.com' },
      { kind: 'regex', value: '.*' },
      { kind: 'domain', value: 'tracker.com' },
    ])).toEqual([
      { kind: 'email', value: 'a@b.com' },
      { kind: 'domain', value: 'tracker.com' },
    ])
  })
})

describe('parseBlockedListText', () => {
  it('每行一项，含 @ 当邮箱，否则当域名', () => {
    expect(parseBlockedListText('noreply@spam.com\ntracker.com')).toEqual([
      { kind: 'email', value: 'noreply@spam.com' },
      { kind: 'domain', value: 'tracker.com' },
    ])
  })

  it('@domain 形态（UI 示例里就是这么写的）识别成域名而不是邮箱', () => {
    // 这一条是这里最容易写错的地方：`@tracker.com` 含 `@`，按「含 @ 即邮箱」
    // 的规则会被当成邮箱，而用户的本意显然是域名
    expect(parseBlockedListText('@tracker.com')).toEqual([{ kind: 'domain', value: 'tracker.com' }])
  })

  it('逗号 / 分号分隔也吃下，注释与空行忽略', () => {
    expect(parseBlockedListText('# 注释\n\na@b.com, c@d.com; e.com')).toEqual([
      { kind: 'email', value: 'a@b.com' },
      { kind: 'email', value: 'c@d.com' },
      { kind: 'domain', value: 'e.com' },
    ])
  })

  it('非法行被忽略而不是产生垃圾条目', () => {
    expect(parseBlockedListText('这不是地址\n<<<>>>')).toEqual([])
  })
})

describe('normalizeRetention', () => {
  it('接受四个数字档位与 unlimited', () => {
    expect(normalizeRetention(500, 100)).toBe(500)
    expect(normalizeRetention('1000', 100)).toBe(1000)
    expect(normalizeRetention('unlimited', 100)).toBe('unlimited')
  })

  it('非法值退回默认', () => {
    expect(normalizeRetention(7, 100)).toBe(100)
    expect(normalizeRetention('many', 200)).toBe(200)
    expect(normalizeRetention(null, 100)).toBe(100)
  })
})

describe('normalizeCursor', () => {
  it('空的 / 无效的游标归一成 null（= 从未同步过）', () => {
    expect(normalizeCursor(undefined)).toBeNull()
    expect(normalizeCursor(null)).toBeNull()
    expect(normalizeCursor({})).toBeNull()
    expect(normalizeCursor({ uid: 'abc' })).toBeNull()
  })

  it('iMAP 游标保留 uid 与 uidValidity', () => {
    expect(normalizeCursor({ uid: 4392, uidValidity: 7 })).toEqual({ uid: 4392, uidValidity: 7 })
  })

  it('gmail 游标保留 historyId', () => {
    expect(normalizeCursor({ historyId: '12345' })).toEqual({ historyId: '12345' })
  })

  it('把设计文档早期的顶层 lastSeenUid 搬进 cursor', () => {
    /*
     * 这是最要紧的一条：`lastSeenUid` 曾经是 MailAccount 的**顶层字段**。
     * 不迁的话，老账号第一次心跳会被当成「从未同步过」而重新记游标 —— 症状是
     * 「升级后中间一段邮件永远收不到」，而用户完全无从察觉。
     */
    expect(normalizeCursor(undefined, { lastSeenUid: 100, uidValidity: 3 }))
      .toEqual({ uid: 100, uidValidity: 3 })
  })

  it('cursor 里已有值时不被顶层旧字段覆盖', () => {
    expect(normalizeCursor({ uid: 200 }, { lastSeenUid: 100 })).toEqual({ uid: 200 })
  })

  it('hasNoCursor 判「首次同步」', () => {
    expect(hasNoCursor({ cursor: null })).toBe(true)
    expect(hasNoCursor({ cursor: {} })).toBe(true)
    expect(hasNoCursor({ cursor: { uid: 0 } })).toBe(false)
  })
})

describe('normalizeAccount', () => {
  it('补齐字段并归一邮箱大小写', () => {
    const account = normalizeAccount({ email: 'Me@Example.COM' }, 'a1')
    expect(account).not.toBeNull()
    expect(account!.id).toBe('a1')
    expect(account!.email).toBe('me@example.com')
    // label 空时退化为邮箱（列表里必须有东西可显示）
    expect(account!.label).toBe('me@example.com')
    expect(account!.enabled).toBe(true)
    expect(account!.blockedList).toEqual([])
    expect(account!.cursor).toBeNull()
  })

  it('未知 provider 退回 imap（而不是留一个没人认识的 id）', () => {
    expect(normalizeAccount({ id: 'a1', provider: 'pop3' })!.provider).toBe('imap')
  })

  it('config 只保留已知字段', () => {
    const account = normalizeAccount({
      id: 'a1',
      config: { host: 'imap.a.com', pass: 'secret', junk: 'x' },
    })
    expect(account!.config.host).toBe('imap.a.com')
    expect(account!.config.pass).toBe('secret')
    expect('junk' in account!.config).toBe(false)
  })

  it('没有 id 时返回 null（调用方据此跳过脏数据）', () => {
    expect(normalizeAccount({ email: 'a@b.com' })).toBeNull()
    expect(normalizeAccount(null)).toBeNull()
  })
})

describe('normalizeRule', () => {
  it('补齐默认值，priority 退化到 createdAt（保持稳定顺序）', () => {
    const rule = normalizeRule({ id: 'r1', name: '规则', matchers: ['@a.com'], createdAt: 1000 })
    expect(rule).not.toBeNull()
    expect(rule!.enabled).toBe(true)
    expect(rule!.priority).toBe(1000)
    expect(rule!.matchers).toEqual([{ kind: 'domain', value: 'a.com' }])
  })

  it('可选的 always* 字段保持 undefined（而不是被填成 false）', () => {
    // 这个差别有意义：`undefined` = 用户没表过态，`false` = 用户明确关掉了。
    // 将来加「默认值改了要跟随」的逻辑时，两者行为必须不同
    const rule = normalizeRule({ id: 'r1' })
    expect(rule!.alwaysCopyCode).toBeUndefined()
    expect(rule!.alwaysSkipAd).toBeUndefined()
  })
})

describe('normalizeMail', () => {
  it('截断 snippet 到 240 字、bodyText 到 50000 字', () => {
    const mail = normalizeMail({
      id: 'a:1',
      accountId: 'a',
      subject: 's',
      snippet: 'x'.repeat(500),
      bodyText: 'y'.repeat(60_000),
    })
    expect(mail!.snippet.length).toBe(240)
    expect(mail!.bodyText!.length).toBe(50_000)
  })

  it('bodyHtml 一律丢掉（MVP 不存 HTML）', () => {
    const mail = normalizeMail({ id: 'a:1', accountId: 'a', bodyHtml: '<p>hi</p>' })
    expect(mail!.bodyHtml).toBeUndefined()
  })

  it('处理状态与复制状态的非法值退回安全默认', () => {
    const mail = normalizeMail({ id: 'a:1', accountId: 'a', processing: 'weird', copyStatus: 'weird' })
    expect(mail!.processing).toBe('pending')
    expect(mail!.copyStatus).toBe('none')
  })

  it('缺 id / accountId 时返回 null', () => {
    expect(normalizeMail({ accountId: 'a' })).toBeNull()
    expect(normalizeMail({ id: 'a:1' })).toBeNull()
  })

  it('ai 输出缺失或非法时归一成 undefined / 安全默认', () => {
    expect(normalizeMail({ id: 'a:1', accountId: 'a' })!.ai).toBeUndefined()
    const mail = normalizeMail({
      id: 'a:1',
      accountId: 'a',
      ai: { minimal: 'x', urgency: 'URGENT', isAd: 'yes' },
    })
    expect(mail!.ai!.urgency).toBe('normal')
    expect(mail!.ai!.isAd).toBe(false)
  })

  it('把字符串形态的发件人解析成结构化地址', () => {
    const mail = normalizeMail({
      id: 'a:1',
      accountId: 'a',
      from: ['GitHub <Noreply@GitHub.com>', 'plain@x.com'],
    })
    expect(mail!.from).toEqual([
      { name: 'GitHub', address: 'noreply@github.com' },
      { name: '', address: 'plain@x.com' },
    ])
  })
})

describe('normalizeAppSettings', () => {
  it('默认值就是设计文档里那套', () => {
    const app = normalizeAppSettings(undefined)
    expect(app.minimalMode).toBe(true) // 默认极简
    expect(app.excludeAds).toBe(true)
    expect(app.autoCopyCode).toBe(true)
    expect(app.blockedEnabled).toBe(true)
    expect(app.notifyOnNew).toBe(true)
    expect(app.popupDefaultTab).toBe('important')
    expect(app.mailRetention).toBe(100)
    expect(app.schemaVersion).toBe(1)
  })

  it('非法 popupDefaultTab 退回 important（否则 Popup 打开时四个 tab 都不选中）', () => {
    expect(normalizeAppSettings({ popupDefaultTab: 'bogus' }).popupDefaultTab).toBe('important')
  })

  it('负数的 mailRetentionDays 被夹到 0', () => {
    expect(normalizeAppSettings({ mailRetentionDays: -5 }).mailRetentionDays).toBe(0)
  })
})

describe('normalizeAiSettings', () => {
  it('默认平台是 deepseek，输出语言跟随浏览器', () => {
    const ai = normalizeAiSettings(undefined)
    expect(ai.platform).toBe('deepseek')
    expect(ai.outputLanguage).toBe('auto-browser')
    expect(ai.apiKey).toBe('')
    expect(ai.thinking).toBe(false)
  })

  it('未知 outputLanguage 退回 auto-browser', () => {
    expect(normalizeAiSettings({ outputLanguage: 'fr' }).outputLanguage).toBe('auto-browser')
  })
})
