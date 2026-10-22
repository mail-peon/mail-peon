import type { MailTypeRecord } from '~/logic/types'
import { describe, expect, it } from 'vitest'
import { BUILTIN_ADAPTERS } from '~/logic/mail-types/catalog'
import {
  adapterAutoCopyCode,
  adapterById,
  adapterPromptChars,
  estimatePromptTokens,
  resolveMailTypeAdapters,
} from '~/logic/mail-types/resolve'
import {
  BUILTIN_CODE_ID,
  BUILTIN_CONFIRM_ID,
  BUILTIN_SUMMARY_ID,
} from '~/logic/types'

/**
 * 适配器目录 + 合并逻辑。
 *
 * 关键契约：
 *   - 内置三个：验证码 / 确认 / 总结，总结在最后且兜底；
 *   - 自定义类型可以插在中间，但**总结永远最后**（哪怕 priority 更大）；
 *   - 极简模式强制 code + confirm；
 *   - 提示词预算只算生效的适配器。
 */

function custom(patch: Partial<MailTypeRecord> = {}): MailTypeRecord {
  return {
    id: 'custom:budget',
    kind: 'custom',
    name: '账单提醒',
    prompt: '告诉我金额与到期日。',
    enabled: true,
    priority: 100,
    fallback: false,
    createdAt: 100,
    updatedAt: 100,
    ...patch,
  }
}

describe('内置 catalog', () => {
  it('三个内置类型的 id / UI / 兜底关系', () => {
    const byId = Object.fromEntries(BUILTIN_ADAPTERS.map(def => [def.id, def]))

    expect(byId[BUILTIN_CODE_ID].ui).toBe('code')
    expect(byId[BUILTIN_CODE_ID].defaultFallback).toBe(false)
    expect(byId[BUILTIN_CONFIRM_ID].ui).toBe('confirm')
    expect(byId[BUILTIN_SUMMARY_ID].ui).toBe('summary')
    expect(byId[BUILTIN_SUMMARY_ID].defaultFallback).toBe(true)
  })
})

describe('resolveMailTypeAdapters', () => {
  it('默认顺序：验证码 → 确认 → 总结', () => {
    const adapters = resolveMailTypeAdapters([], { minimalMode: false, lang: 'zh' })
    expect(adapters.map(adapter => adapter.id)).toEqual([
      BUILTIN_CODE_ID,
      BUILTIN_CONFIRM_ID,
      BUILTIN_SUMMARY_ID,
    ])
  })

  it('自定义类型插在确认之后、总结之前；即使 priority 更大，总结也最后', () => {
    const adapters = resolveMailTypeAdapters([
      custom({ priority: 2000 }),
    ], { minimalMode: false, lang: 'zh' })

    expect(adapters.map(adapter => adapter.id)).toEqual([
      BUILTIN_CODE_ID,
      BUILTIN_CONFIRM_ID,
      'custom:budget',
      BUILTIN_SUMMARY_ID,
    ])
  })

  it('自定义类型可以按 priority 排序', () => {
    const adapters = resolveMailTypeAdapters([
      custom({ id: 'custom:b', priority: 200, createdAt: 2 }),
      custom({ id: 'custom:a', priority: 150, createdAt: 1 }),
    ], { minimalMode: false, lang: 'zh' })

    expect(adapters.filter(adapter => adapter.kind === 'custom').map(adapter => adapter.id))
      .toEqual(['custom:a', 'custom:b'])
  })

  it('内置 override 能关掉验证码', () => {
    const adapters = resolveMailTypeAdapters([
      { id: BUILTIN_CODE_ID, kind: 'builtin', enabled: false, createdAt: 1, updatedAt: 1 },
    ], { minimalMode: false, lang: 'zh' })

    expect(adapterById(adapters, BUILTIN_CODE_ID)?.enabled).toBe(false)
  })

  it('验证码适配器的 params 参与自动复制取值，缺省回退', () => {
    const withParams = resolveMailTypeAdapters([
      {
        id: BUILTIN_CODE_ID,
        kind: 'builtin',
        params: { autoCopyCode: false },
        createdAt: 1,
        updatedAt: 1,
      },
    ], { minimalMode: false, lang: 'zh' })
    expect(adapterAutoCopyCode(withParams, true)).toBe(false)

    const withoutParams = resolveMailTypeAdapters([], { minimalMode: false, lang: 'zh' })
    expect(adapterAutoCopyCode(withoutParams, false)).toBe(false)
    expect(adapterAutoCopyCode(withoutParams, true)).toBe(true)
  })

  it('极简模式只生效 code + confirm，且自定义 / 总结关闭', () => {
    const adapters = resolveMailTypeAdapters([custom()], { minimalMode: true, lang: 'zh' })
    expect(adapters.filter(adapter => adapter.enabled).map(adapter => adapter.id))
      .toEqual([BUILTIN_CODE_ID, BUILTIN_CONFIRM_ID])
  })

  it('提示词预算只算生效的适配器', () => {
    const enabled = resolveMailTypeAdapters([], { minimalMode: false, lang: 'zh' })
    const disabled = resolveMailTypeAdapters([
      { id: BUILTIN_SUMMARY_ID, kind: 'builtin', enabled: false, createdAt: 1, updatedAt: 1 },
    ], { minimalMode: false, lang: 'zh' })

    expect(adapterPromptChars(enabled)).toBeGreaterThan(adapterPromptChars(disabled))
    expect(estimatePromptTokens(1000)).toBe(500)
  })
})
