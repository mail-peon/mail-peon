import type { Mail, PromptRule } from '~/logic/types'
import { describe, expect, it } from 'vitest'
import { isBlocked, matchedBlockedEntry, parseBlockedText, senderDomain } from '~/logic/rules/blocked'
import { matchesRule, pickRule, resolveIsAd, shouldAutoCopyCode } from '~/logic/rules/matcher'
import { createDefaultRule, DEFAULT_RULE_ID, mailKey } from '~/logic/types'

/**
 * 规则匹配与屏蔽的单测（`03-roadmap.md` M3 验收的前四条）。
 *
 * 这些是**纯函数**，所以能在毫秒级把「精确邮箱 > 域名 > 正则 > 全局默认」
 * 「禁用规则不参与匹配」「域名不误伤 notgithub.com」这些语义钉死 ——
 * 而它们在真机上要靠构造特定发件人的邮件才能验证。
 */

function mail(from: string): Pick<Mail, 'from'> {
  return { from: [{ name: '', address: from }] }
}

function rule(patch: Partial<PromptRule> = {}): PromptRule {
  return { ...createDefaultRule(), id: 'r1', name: 'R', priority: 0, ...patch }
}

describe('matchesRule', () => {
  it('邮箱精确匹配（大小写不敏感）', () => {
    const target = rule({ matchers: [{ kind: 'email', value: 'Admin@Example.com' }] })
    expect(matchesRule(mail('admin@example.com'), target)).toBe(true)
    expect(matchesRule(mail('other@example.com'), target)).toBe(false)
    // 子地址不该命中精确匹配
    expect(matchesRule(mail('admin+tag@example.com'), target)).toBe(false)
  })

  it('域名匹配且支持子域', () => {
    const target = rule({ matchers: [{ kind: 'domain', value: 'github.com' }] })
    expect(matchesRule(mail('noreply@github.com'), target)).toBe(true)
    expect(matchesRule(mail('a@mail.github.com'), target)).toBe(true)
  })

  it('域名匹配不误伤相似域名（这是静默过度匹配的来源）', () => {
    const target = rule({ matchers: [{ kind: 'domain', value: 'github.com' }] })
    // 裸 endsWith 会把这两个判为命中 —— 用户的规则会作用在完全无关的邮件上
    expect(matchesRule(mail('x@notgithub.com'), target)).toBe(false)
    expect(matchesRule(mail('x@github.com.evil.com'), target)).toBe(false)
  })

  it('正则匹配（忽略大小写）', () => {
    const target = rule({ matchers: [{ kind: 'regex', value: '^ci-.*@example\\.com$' }] })
    expect(matchesRule(mail('CI-build@example.com'), target)).toBe(true)
    expect(matchesRule(mail('dev@example.com'), target)).toBe(false)
  })

  it('非法正则不命中，也不抛错（一条写错的规则不该让整轮同步失败）', () => {
    const target = rule({ matchers: [{ kind: 'regex', value: '([unclosed' }] })
    expect(() => matchesRule(mail('a@b.com'), target)).not.toThrow()
    expect(matchesRule(mail('a@b.com'), target)).toBe(false)
  })

  it('空匹配器 / 空发件人一律不命中', () => {
    expect(matchesRule(mail('a@b.com'), rule({ matchers: [] }))).toBe(false)
    expect(matchesRule({ from: [] }, rule({ matchers: [{ kind: 'domain', value: 'b.com' }] }))).toBe(false)
  })
})

describe('pickRule', () => {
  it('没有命中时返回内置默认规则（返回类型非空，调用方不用处理 null）', () => {
    const picked = pickRule(mail('a@b.com'), [rule({ matchers: [{ kind: 'domain', value: 'other.com' }] })])
    expect(picked.id).toBe(DEFAULT_RULE_ID)
  })

  it('按 priority 顺序取第一条命中的（数组已排好序，函数不再排）', () => {
    const rules = [
      rule({ id: 'first', priority: 0, matchers: [{ kind: 'domain', value: 'github.com' }] }),
      rule({ id: 'second', priority: 1, matchers: [{ kind: 'domain', value: 'github.com' }] }),
    ]
    expect(pickRule(mail('a@github.com'), rules).id).toBe('first')
  })

  it('禁用的规则不参与匹配（会落到下一条）', () => {
    const rules = [
      rule({ id: 'disabled', priority: 0, enabled: false, matchers: [{ kind: 'domain', value: 'github.com' }] }),
      rule({ id: 'enabled', priority: 1, matchers: [{ kind: 'domain', value: 'github.com' }] }),
    ]
    expect(pickRule(mail('a@github.com'), rules).id).toBe('enabled')
  })

  it('同一规则内多个匹配器任一命中即命中', () => {
    const target = rule({
      matchers: [
        { kind: 'email', value: 'me@a.com' },
        { kind: 'domain', value: 'b.com' },
      ],
    })
    expect(matchesRule(mail('me@a.com'), target)).toBe(true)
    expect(matchesRule(mail('x@b.com'), target)).toBe(true)
    expect(matchesRule(mail('x@c.com'), target)).toBe(false)
  })
})

describe('isBlocked', () => {
  it('邮箱条目精确匹配', () => {
    const list = [{ kind: 'email' as const, value: 'noreply@spam.com' }]
    expect(isBlocked(mail('noreply@spam.com'), list)).toBe(true)
    expect(isBlocked(mail('noreply@spam.com.evil.com'), list)).toBe(false)
  })

  it('域名条目支持任意层级子域', () => {
    const list = [{ kind: 'domain' as const, value: 'tracker.com' }]
    expect(isBlocked(mail('a@tracker.com'), list)).toBe(true)
    expect(isBlocked(mail('a@b.c.tracker.com'), list)).toBe(true)
    // 不误伤
    expect(isBlocked(mail('a@nottracker.com'), list)).toBe(false)
  })

  it('空列表 / 未定义列表一律不屏蔽', () => {
    expect(isBlocked(mail('a@b.com'), [])).toBe(false)
    expect(isBlocked(mail('a@b.com'), undefined)).toBe(false)
  })

  it('条目带前导 @ 也能匹配（用户可能手写过）', () => {
    expect(isBlocked(mail('a@tracker.com'), [{ kind: 'domain', value: '@tracker.com' }])).toBe(true)
  })

  it('matchedBlockedEntry 指出命中了哪一条（UI 标「已屏蔽」用）', () => {
    const list = [
      { kind: 'domain' as const, value: 'other.com' },
      { kind: 'email' as const, value: 'a@b.com' },
    ]
    expect(matchedBlockedEntry(mail('a@b.com'), list)).toEqual({ kind: 'email', value: 'a@b.com' })
  })

  it('senderDomain 抽域名', () => {
    expect(senderDomain(mail('Noreply@GitHub.COM'))).toBe('github.com')
    expect(senderDomain({ from: [{ name: 'x', address: 'no-at-sign' }] })).toBe('')
  })
})

describe('parseBlockedText', () => {
  it('@domain 视为域名，含 @ 视为邮箱，都不含视为域名', () => {
    expect(parseBlockedText('@tracker.com\nnoreply@spam.com\nother.com')).toEqual([
      { kind: 'domain', value: 'tracker.com' },
      { kind: 'email', value: 'noreply@spam.com' },
      { kind: 'domain', value: 'other.com' },
    ])
  })

  it('去重', () => {
    expect(parseBlockedText('@a.com\na.com')).toEqual([{ kind: 'domain', value: 'a.com' }])
  })

  it('忽略空行与注释', () => {
    expect(parseBlockedText('\n# comment\n\n  \na@b.com')).toEqual([{ kind: 'email', value: 'a@b.com' }])
  })

  it('丢弃不成形的行而不是产生垃圾条目', () => {
    expect(parseBlockedText('hello world\n<<<>>>\n@@@')).toEqual([])
  })
})

describe('shouldAutoCopyCode（features/05 § 2 的决策表）', () => {
  it('全局开关开着就复制', () => {
    expect(shouldAutoCopyCode({ minimalMode: false, autoCopyCode: true }, null)).toBe(true)
  })

  it('全局关掉时不复制', () => {
    expect(shouldAutoCopyCode({ minimalMode: false, autoCopyCode: false }, null)).toBe(false)
  })

  it('规则的 alwaysCopyCode 能覆盖全局关闭', () => {
    expect(shouldAutoCopyCode({ minimalMode: false, autoCopyCode: false }, { alwaysCopyCode: true })).toBe(true)
  })

  it('极简模式**恒为 true**（漏掉这条特判等于把这个功能废掉）', () => {
    expect(shouldAutoCopyCode({ minimalMode: true, autoCopyCode: false }, null)).toBe(true)
  })
})

describe('resolveIsAd（features/04 § 3）', () => {
  it('默认用 AI 的判定', () => {
    expect(resolveIsAd(true, null)).toBe(true)
    expect(resolveIsAd(false, null)).toBe(false)
  })

  it('alwaysSkipAd 能推翻 AI 的 isAd=true（用户主动认领的发件人绕过过滤）', () => {
    expect(resolveIsAd(true, { alwaysSkipAd: true })).toBe(false)
  })

  it('alwaysSkipAd=false 不改变 AI 的判定', () => {
    expect(resolveIsAd(true, { alwaysSkipAd: false })).toBe(true)
  })
})

describe('账本键', () => {
  it('mailKey 拼法稳定（两处不一致的症状是邮件重复入库）', () => {
    expect(mailKey('acc-1', 'msg-2')).toBe('acc-1:msg-2')
  })
})
