import { describe, expect, it } from 'vitest'
import { MAIL_PROVIDERS, mailProviderOptionPayloads } from '../registry'

/*
 * 这组测试守的是一条**真实踩过的坑**，不是形式化的覆盖率。
 *
 * 起因：`background/main.ts` 的 `mail:providers` handler 把每个字段逐个手抄成
 * 白名单（key / label / type / placeholder / required / default），**漏了 `presets`**。
 * 于是 IMAP provider 里写好的 13 个常用服务器预设，到了 Options 就消失了，
 * `v-else-if="field.presets"` 永远不成立，表单一直退化成普通输入框 ——
 * 「下拉选常用邮箱」这个功能在真机上整个不存在。
 *
 * 而当时的单测全绿：因为 AccountsPage 的测试把 `send('mail:providers')` 整个 mock 掉了，
 * 直接把自己造的（带 presets 的）对象喂给组件，**绕过了这条真实链路**。
 *
 * 所以这里不测具体某几个字段，而是**逐个字段比对源对象和载荷对象的 key** ——
 * 以后再加字段（或者再有人想抄白名单）会被立刻拦下。
 */

describe('mail:providers 载荷', () => {
  const payloads = mailProviderOptionPayloads()

  it('覆盖所有 provider，顺序与声明一致', () => {
    expect(payloads.map(p => p.value)).toEqual(MAIL_PROVIDERS.map(d => d.id))
  })

  it('字段对象不丢 key —— 载荷的每个字段都得涵盖源字段的所有属性', () => {
    for (const definition of MAIL_PROVIDERS) {
      const payload = payloads.find(p => p.value === definition.id)
      expect(payload, `缺 provider ${definition.id}`).toBeDefined()

      definition.fields.forEach((sourceField, index) => {
        const payloadField = payload!.fields[index] as unknown as Record<string, unknown>
        const sourceKeys = Object.keys(sourceField)
        const missing = sourceKeys.filter(key => !(key in payloadField))

        expect(missing, `${definition.id}.${String(sourceField.key)} 丢了属性：${missing.join(', ')}`).toEqual([])
      })
    }
  })

  it('iMAP 的 host 字段带着预设清单 —— 这是踩坑的那一个', () => {
    const imap = payloads.find(p => p.value === 'imap')
    expect(imap).toBeDefined()

    const host = imap!.fields.find(field => field.key === 'host')
    expect(host).toBeDefined()
    expect(host!.presets, 'host 字段没有 presets —— 界面会退化成普通输入框').toBeDefined()

    const hosts = host!.presets!.map(preset => preset.value)
    expect(hosts).toContain('imap.qq.com')
    expect(hosts).toContain('imap.163.com')

    // 每条预设都得能写进字段：value 必须有；port / tls 是可选覆盖
    for (const preset of host!.presets!) {
      expect(preset.label).toBeTruthy()
      expect(preset.value).toBeTruthy()
    }
  })

  it('载荷能被结构化克隆 —— 这是消息通道的硬要求', () => {
    // structuredClone 会对着不可克隆的东西（函数、DOM 节点…）抛 DataCloneError。
    // 直接走一遍，比靠人眼审查 `MailProviderField` 的定义可靠。
    expect(() => structuredClone(payloads)).not.toThrow()
  })

  it('字段 key 一律是 string —— 界面要拿它当 config 下标和 v-for :key', () => {
    for (const payload of payloads) {
      for (const field of payload.fields)
        expect(typeof field.key).toBe('string')
    }
  })
})
