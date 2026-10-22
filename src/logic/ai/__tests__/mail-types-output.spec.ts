import type { Mail } from '~/logic/types'
import { describe, expect, it } from 'vitest'
import { fallbackResult, parseAiResult } from '~/logic/ai/output-schema'
import { resolveMailTypeAdapters } from '~/logic/mail-types/resolve'
import { BUILTIN_CODE_ID, BUILTIN_CONFIRM_ID, BUILTIN_SUMMARY_ID, mailKey } from '~/logic/types'

/**
 * 确认邮件 / 自定义类型 / 有效期的输出解析。
 *
 * 与 `ai.spec.ts` 的分工：那边守「验证码 + 状态位 + 兜底」的主干，
 * 这里守 Feature 08 新增的两类数据。
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
  return {
    id: mailKey('a1', 'm1'),
    accountId: 'a1',
    from: [{ name: '测试', address: 'from@example.com' }],
    to: [],
    subject: 'Please confirm your email address',
    snippet: 'confirm',
    receivedAt: 1_700_000_000_000,
    processing: 'sent',
    copyStatus: 'none',
    read: false,
    stateFlags: 0,
    messageId: 'm1',
    ...patch,
  }
}

function parse(payload: unknown, target: Mail = mail()) {
  return parseAiResult(JSON.stringify(payload), { adapters, mail: target })
}

describe('确认邮件解析', () => {
  it('相对时长 → 绝对失效时刻 + 进度条分母', () => {
    const result = parse({
      types: [
        {
          adapterId: BUILTIN_CONFIRM_ID,
          confirm: { url: 'https://example.com/confirm/abc', validForSeconds: '1 小时' },
        },
      ],
    })

    expect(result.ok).toBe(true)
    if (!result.ok)
      throw new Error(result.error)

    const match = result.result.output.types[0]
    expect(match.kind).toBe('confirm')
    if (match.kind === 'confirm') {
      expect(match.url).toBe('https://example.com/confirm/abc')
      expect(match.host).toBe('example.com')
      expect(match.expiry?.totalSeconds).toBe(3600)
      expect(match.expiry?.at).toBe(1_700_000_000_000 + 3_600_000)
    }
  })

  it('链接里的绝对时间戳 → 直接作为失效时刻', () => {
    const expiresAt = new Date(1_700_000_000_000 + 86_400_000).toISOString()
    const result = parse({
      types: [
        {
          adapterId: BUILTIN_CONFIRM_ID,
          confirm: { url: 'https://example.com/confirm/abc', expiresAt },
        },
      ],
    })

    expect(result.ok).toBe(true)
    if (!result.ok)
      throw new Error(result.error)

    const match = result.result.output.types[0]
    if (match.kind === 'confirm') {
      expect(match.expiry?.at).toBe(Date.parse(expiresAt))
      expect(match.expiry?.totalSeconds).toBe(86_400)
    }
  })

  it('离谱的绝对时间被忽略（不会显示几年的倒计时）', () => {
    const result = parse({
      types: [
        {
          adapterId: BUILTIN_CONFIRM_ID,
          confirm: { url: 'https://example.com/confirm/abc', expiresAt: '2035-01-01T00:00:00Z' },
        },
      ],
    })

    expect(result.ok).toBe(true)
    if (!result.ok)
      throw new Error(result.error)

    const match = result.result.output.types[0]
    if (match.kind === 'confirm')
      expect(match.expiry).toBeUndefined()
  })
})

describe('自定义类型解析', () => {
  it('自定义适配器只收一段文本', () => {
    const result = parse({
      types: [
        { adapterId: 'custom:budget', custom: { text: '本期账单 100 元，10 天后到期。' } },
      ],
    })

    expect(result.ok).toBe(true)
    if (!result.ok)
      throw new Error(result.error)

    const match = result.result.output.types[0]
    expect(match.kind).toBe('custom')
    if (match.kind === 'custom')
      expect(match.text).toContain('100 元')
  })

  it('自定义类型是非兜底：命中时总结被丢', () => {
    const result = parse({
      types: [
        { adapterId: 'custom:budget', custom: { text: '账单' } },
        { adapterId: BUILTIN_SUMMARY_ID, summary: { minimal: '一行', text: '摘要' } },
      ],
    })

    expect(result.ok).toBe(true)
    if (!result.ok)
      throw new Error(result.error)

    expect(result.result.output.types.map(match => match.kind)).toEqual(['custom'])
    expect(result.result.output.summary).toBeUndefined()
  })

  it('验证码 + 自定义可以同时命中（多个标签）', () => {
    const result = parse({
      types: [
        { adapterId: BUILTIN_CODE_ID, code: { value: '123456' } },
        { adapterId: 'custom:budget', custom: { text: '账单' } },
      ],
    })

    expect(result.ok).toBe(true)
    if (!result.ok)
      throw new Error(result.error)

    expect(result.result.output.types.map(match => match.kind)).toEqual(['code', 'custom'])
  })
})

describe('降级路径的兜底规则', () => {
  it('启发式验证码命中时不再生成总结', () => {
    const result = fallbackResult(
      mail({ bodyText: '您的验证码是 123456' }),
      adapters,
      '网络超时',
    )

    expect(result.output.types.map(match => match.kind)).toEqual(['code'])
    expect(result.output.types.some(match => match.kind === 'summary')).toBe(false)
  })
})
