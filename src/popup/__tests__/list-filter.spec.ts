import type { Mail, MailTypeMatch } from '~/logic/types'
import { describe, expect, it } from 'vitest'
import { resolveMailTypeAdapters } from '~/logic/mail-types/resolve'
import {
  BUILTIN_CODE_ID,
  BUILTIN_CONFIRM_ID,
  BUILTIN_SUMMARY_ID,
  mailKey,
  MailStateFlag,
} from '~/logic/types'
import {
  buildMailFilters,
  filterMails,
  isImportant,
  mailSummaryLine,
  minimalModeMails,
} from '~/popup/list-filter'

/**
 * 列表筛选（Feature 08 的动态标签）。
 *
 * 三类标签：
 *   - 状态：重要（派生）/ 营销（Ad 位）
 *   - 内置适配器：验证码 / 确认
 *   - 自定义适配器：用户自己的类型名
 */

const adapters = resolveMailTypeAdapters([
  {
    id: 'custom:budget',
    kind: 'custom',
    name: '账单提醒',
    prompt: '告诉我金额。',
    enabled: true,
    priority: 100,
    fallback: false,
    createdAt: 1,
    updatedAt: 1,
  },
], { minimalMode: false, lang: 'zh' })

function mail(patch: Partial<Mail> = {}): Mail {
  const messageId = patch.messageId ?? 'm1'
  return {
    id: mailKey('a1', messageId),
    accountId: 'a1',
    from: [{ name: '测试', address: 'from@example.com' }],
    to: [],
    subject: '主题',
    snippet: '正文片段',
    receivedAt: 1_700_000_000_000,
    processing: 'sent',
    copyStatus: 'none',
    read: false,
    stateFlags: 0,
    messageId,
    ...patch,
  }
}

function codeMatch(code = '123456'): MailTypeMatch {
  return { kind: 'code', adapterId: BUILTIN_CODE_ID, adapterName: '验证码', code }
}

function confirmMatch(): MailTypeMatch {
  return {
    kind: 'confirm',
    adapterId: BUILTIN_CONFIRM_ID,
    adapterName: '确认邮件',
    url: 'https://example.com/confirm',
    host: 'example.com',
  }
}

function customMatch(): MailTypeMatch {
  return { kind: 'custom', adapterId: 'custom:budget', adapterName: '账单提醒', text: '金额 100 元' }
}

function summaryMatch(): MailTypeMatch {
  return { kind: 'summary', adapterId: BUILTIN_SUMMARY_ID, adapterName: '总结', minimal: '一行', text: '摘要' }
}

describe('buildMailFilters', () => {
  it('顺序：重要 → 全部 → 内置适配器 → 自定义 → 营销', () => {
    const filters = buildMailFilters([], adapters, { excludeAds: true })
    expect(filters.map(filter => filter.id)).toEqual([
      'important',
      'all',
      `adapter:${BUILTIN_CODE_ID}`,
      `adapter:${BUILTIN_CONFIRM_ID}`,
      'adapter:custom:budget',
      'ad',
    ])
  })

  it('计数按各自的定义算', () => {
    const mails = [
      mail({ messageId: 'code', ai: { types: [codeMatch()] } }),
      mail({ messageId: 'confirm', ai: { types: [confirmMatch()] } }),
      mail({ messageId: 'custom', ai: { types: [customMatch()] } }),
      mail({ messageId: 'ad', stateFlags: MailStateFlag.Ad }),
    ]

    const filters = buildMailFilters(mails, adapters, { excludeAds: true })
    const count = (id: string) => filters.find(filter => filter.id === id)?.count

    expect(count('all')).toBe(4)
    expect(count(`adapter:${BUILTIN_CODE_ID}`)).toBe(1)
    expect(count(`adapter:${BUILTIN_CONFIRM_ID}`)).toBe(1)
    expect(count('adapter:custom:budget')).toBe(1)
    expect(count('ad')).toBe(1)
  })
})

describe('filterMails', () => {
  const mails = [
    mail({ messageId: 'both', ai: { types: [codeMatch(), confirmMatch()] } }),
    mail({ messageId: 'plain' }),
  ]

  it('适配器筛选包含「多类型同时命中」的邮件', () => {
    const code = filterMails(mails, `adapter:${BUILTIN_CODE_ID}`, { excludeAds: true })
    const confirm = filterMails(mails, `adapter:${BUILTIN_CONFIRM_ID}`, { excludeAds: true })
    expect(code.map(item => item.messageId)).toEqual(['both'])
    expect(confirm.map(item => item.messageId)).toEqual(['both'])
  })

  it('指向已删除适配器的筛选返回空；完全未知的 id 回退为全部', () => {
    // 适配器被删掉时，Popup 的 watch 会把 activeFilter 拉回「重要」；
    // 这里直接调用时按「筛出该适配器」处理，自然是空。
    expect(filterMails(mails, 'adapter:custom:gone', { excludeAds: true })).toHaveLength(0)
    // 非 adapter: 前缀的未知 id 才走兜底
    expect(filterMails(mails, 'legacy-unknown' as never, { excludeAds: true })).toHaveLength(2)
  })
})

describe('isImportant', () => {
  const app = { excludeAds: true }

  it('广告 / 低优先级不算重要', () => {
    expect(isImportant(mail({ stateFlags: MailStateFlag.Ad }), app)).toBe(false)
    expect(isImportant(mail({ stateFlags: MailStateFlag.LowPriority }), app)).toBe(false)
  })

  it('验证码 / 确认即使被标低优先级也留在重要', () => {
    expect(isImportant(mail({
      stateFlags: MailStateFlag.LowPriority,
      ai: { types: [codeMatch()] },
    }), app)).toBe(true)
    expect(isImportant(mail({
      stateFlags: MailStateFlag.LowPriority,
      ai: { types: [confirmMatch()] },
    }), app)).toBe(true)
  })
})

describe('minimalModeMails', () => {
  it('只保留验证码 / 确认，按时间倒序', () => {
    const mails = [
      mail({ messageId: 'code', receivedAt: 100, ai: { types: [codeMatch()] } }),
      mail({ messageId: 'confirm', receivedAt: 300, ai: { types: [confirmMatch()] } }),
      mail({ messageId: 'summary', receivedAt: 200, ai: { types: [summaryMatch()] } }),
    ]

    expect(minimalModeMails(mails).map(item => item.messageId)).toEqual(['confirm', 'code'])
  })
})

describe('mailSummaryLine', () => {
  it('按「现在要做什么」优先：验证码 → 确认 → 自定义 → 总结 → snippet', () => {
    expect(mailSummaryLine(mail({ ai: { types: [codeMatch()] } }))).toContain('123456')
    expect(mailSummaryLine(mail({ ai: { types: [confirmMatch()] } }))).toContain('确认')
    expect(mailSummaryLine(mail({ ai: { types: [customMatch()] } }))).toContain('账单提醒')
    expect(mailSummaryLine(mail({ ai: { types: [summaryMatch()] } }))).toBe('一行')
    expect(mailSummaryLine(mail())).toBe('正文片段')
  })
})
