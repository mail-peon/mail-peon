import type { AiPlatformDefinition } from '../platforms/types'
import { describe, expect, it } from 'vitest'
import { AI_PLATFORM_OPTION_EXCLUDED, AI_PLATFORM_OPTIONS, AI_PLATFORMS } from '../platforms'

/*
 * 这组守的是**一个真实踩过的坑**，不是形式化覆盖率。
 *
 * `AI_PLATFORM_OPTIONS` 是手抄字段的，抄的时候漏了 `thinkingToggle`。后果：
 *
 *   - AI 配置页的「启用思考模式」勾选框对**所有**平台都照常显示；
 *   - 而协议层靠 `config.thinkingToggle` 决定发不发那个参数
 *     （`protocols/openai.ts` / `anthropic.ts` 都是 `if (!config.thinkingToggle) return`）；
 *   - 于是用户在 OpenAI / Anthropic 上勾了它，**什么都不会发生，也没有任何提示**。
 *
 * 这与邮件 provider 漏掉 `presets`（下拉列表整个消失）是同一个形状：
 * 上游声明得好好的，中间一层手抄时丢了，界面就一直按「没有这个能力」渲染。
 */

/** 载荷里的字段各自对应源定义的哪个字段（`value` ← `id`、`nativeJson` ← `capabilities`） */
const PAYLOAD_TO_SOURCE: Record<string, keyof AiPlatformDefinition> = {
  value: 'id',
  label: 'label',
  hint: 'hint',
  defaultBaseUrl: 'defaultBaseUrl',
  defaultModel: 'defaultModel',
  nativeJson: 'capabilities',
  thinkingToggle: 'thinkingToggle',
}

describe('ai:platforms 载荷', () => {
  it('覆盖所有平台，顺序与声明一致', () => {
    expect(AI_PLATFORM_OPTIONS.map(item => item.value)).toEqual(AI_PLATFORMS.map(item => item.id))
  })

  /*
   * ⚠ 这条就是踩坑的那一个：`thinkingToggle` 必须真的传出去，
   *   而且要和源声明**逐平台一致**（不能写死成 true）。
   */
  it('每条都带 thinkingToggle，且与平台声明一致', () => {
    for (const platform of AI_PLATFORMS) {
      const option = AI_PLATFORM_OPTIONS.find(item => item.value === platform.id)
      expect(option, `缺平台 ${platform.id}`).toBeDefined()
      expect(
        option!.thinkingToggle,
        `${platform.id} 的 thinkingToggle 和声明对不上 —— 界面会显示一个勾了没用的开关`,
      ).toBe(platform.thinkingToggle)
    }

    // 声明里确实有 true 也有 false，否则这条断言没有区分力
    const values = new Set(AI_PLATFORM_OPTIONS.map(item => item.thinkingToggle))
    expect(values).toEqual(new Set([true, false]))
  })

  /*
   * 数据驱动：给 `AiPlatformDefinition` 加任何字段，都必须**明确决定**它过不过通道 ——
   * 要么加进载荷，要么加进 `AI_PLATFORM_OPTION_EXCLUDED` 并写清理由。
   * 这条会在两者都没做时报错，于是「漏了一个字段」不可能悄悄发生。
   */
  it('源定义的每个字段都有归宿：要么过通道，要么在排除表里有理由', () => {
    const sourceKeys = new Set(Object.keys(AI_PLATFORMS[0]) as Array<keyof AiPlatformDefinition>)
    const covered = new Set(Object.keys(AI_PLATFORM_OPTIONS[0]).map(key => PAYLOAD_TO_SOURCE[key]))

    const unaccounted = [...sourceKeys].filter(key => !covered.has(key) && !AI_PLATFORM_OPTION_EXCLUDED.has(key))

    expect(
      unaccounted,
      `AiPlatformDefinition 里这些字段既没过通道也没进排除表：${unaccounted.join(', ')}。\n`
      + '界面需要它们就加进 AI_PLATFORM_OPTIONS；不需要就加进 AI_PLATFORM_OPTION_EXCLUDED 并写清理由。',
    ).toEqual([])
  })

  it('载荷能被结构化克隆 —— 这是消息通道的硬要求', () => {
    // `capabilities` 之外的 `protocol` 里带函数，误用 `...platform` 展开会当场抛 DataCloneError
    expect(() => structuredClone(AI_PLATFORM_OPTIONS)).not.toThrow()
  })
})
