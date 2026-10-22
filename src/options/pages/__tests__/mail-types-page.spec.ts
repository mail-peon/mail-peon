import type { MailTypeAdapter, MailTypeRecord } from '~/logic/types'
import { mount } from '@vue/test-utils'
import { beforeAll, describe, expect, it, vi } from 'vitest'
import { ref } from 'vue'
import { resolveMailTypeAdapters } from '~/logic/mail-types/resolve'

/**
 * 适配器配置页的「模式锁定」契约。
 *
 * 需求：极简模式下所有开关禁用、不能新增；自定义模式下可以操作。
 * 这是模式语义的唯一入口 —— 后端还有一道 guard，但界面必须先说清楚。
 */

const mocks = vi.hoisted(() => ({
  adapters: [] as unknown as { value: MailTypeAdapter[] },
  app: [] as unknown as { value: { minimalMode: boolean } },
  setEnabled: vi.fn(async () => {}),
  setUserPrompt: vi.fn(async () => {}),
  setParams: vi.fn(async () => {}),
  create: vi.fn(async () => ({ ok: true })),
  update: vi.fn(async () => {}),
  remove: vi.fn(async () => {}),
  move: vi.fn(async () => {}),
  reset: vi.fn(async () => {}),
}))

vi.mock('~/logic/bridge', () => ({
  useMailTypes: () => ({
    adapters: mocks.adapters,
    setEnabled: mocks.setEnabled,
    setUserPrompt: mocks.setUserPrompt,
    setParams: mocks.setParams,
    create: mocks.create,
    update: mocks.update,
    remove: mocks.remove,
    move: mocks.move,
    reset: mocks.reset,
  }),
  useSettings: () => ({ app: mocks.app }),
}))

const customRecord: MailTypeRecord = {
  id: 'custom:budget',
  kind: 'custom',
  name: '账单提醒',
  prompt: '告诉我金额与到期日。',
  enabled: true,
  priority: 100,
  fallback: false,
  createdAt: 1,
  updatedAt: 1,
}

let MailTypesPage: import('vue').Component
beforeAll(async () => {
  MailTypesPage = (await import('~/options/pages/MailTypesPage.vue')).default
})

function setMode(minimalMode: boolean) {
  const adapters = resolveMailTypeAdapters([customRecord], {
    minimalMode,
    lang: 'zh',
  })
  mocks.adapters = ref(adapters) as unknown as { value: MailTypeAdapter[] }
  mocks.app = ref({ minimalMode }) as unknown as { value: { minimalMode: boolean } }
}

describe('mailTypesPage 的模式锁定', () => {
  it('极简模式：开关全部禁用、新增按钮禁用', async () => {
    setMode(true)
    const wrapper = mount(MailTypesPage, { attachTo: document.body })

    const switches = wrapper.findAll('.ant-switch')
    expect(switches.length).toBeGreaterThan(0)
    for (const node of switches)
      expect(node.classes()).toContain('ant-switch-disabled')

    const add = wrapper.findAll('button').find(node => node.text().includes('新增自定义类型'))
    expect(add?.attributes('disabled')).toBeDefined()

    wrapper.unmount()
  })

  it('自定义模式：开关可用、新增按钮可用', async () => {
    setMode(false)
    const wrapper = mount(MailTypesPage, { attachTo: document.body })

    const switches = wrapper.findAll('.ant-switch')
    expect(switches.length).toBeGreaterThan(0)
    for (const node of switches)
      expect(node.classes()).not.toContain('ant-switch-disabled')

    const add = wrapper.findAll('button').find(node => node.text().includes('新增自定义类型'))
    expect(add?.attributes('disabled')).toBeUndefined()

    wrapper.unmount()
  })

  it('验证码的「自动复制」在极简模式下仍可调整', async () => {
    setMode(true)
    const wrapper = mount(MailTypesPage, { attachTo: document.body })

    const autoCopy = wrapper.findAll('.ant-checkbox-wrapper')
      .find(node => node.text().includes('自动复制验证码'))
    expect(autoCopy).toBeTruthy()
    expect(autoCopy?.classes()).not.toContain('ant-checkbox-wrapper-disabled')

    await autoCopy?.find('input').trigger('click')
    expect(mocks.setParams).toHaveBeenCalledWith(
      'builtin:code',
      expect.objectContaining({ autoCopyCode: expect.any(Boolean) }),
    )

    const autoDelete = wrapper.findAll('.ant-checkbox-wrapper')
      .find(node => node.text().includes('失效后自动删除'))
    expect(autoDelete).toBeTruthy()
    expect(autoDelete?.classes()).not.toContain('ant-checkbox-wrapper-disabled')

    await autoDelete?.find('input').trigger('click')
    expect(mocks.setParams).toHaveBeenCalledWith(
      'builtin:code',
      expect.objectContaining({ autoDeleteExpiredCode: expect.any(Boolean) }),
    )

    wrapper.unmount()
  })
})
