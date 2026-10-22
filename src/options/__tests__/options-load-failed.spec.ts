import { mount } from '@vue/test-utils'
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { ref } from 'vue'
import { t } from '~/logic/strings'

/**
 * 设置页的「加载中」和「加载失败」必须是**两种界面**。
 *
 * ## 这一组对应一个永远转圈的缺陷
 *
 * `Options.vue` 原来是 `<a-spin v-if="!app">` —— 只判 `app` 有没有值。
 * 而 `send` 失败时**不抛错**，只返回兜底值，这里就是 `app: null`：
 *
 *   - 「还在加载」→ `app === null`
 *   - 「加载失败」→ `app === null`
 *
 * 两个状态在判据上完全一样，于是后台异常时用户看到的是一个**转不完的圈**，
 * 没有错误、没有重试，只有 console 里一行 warn。
 *
 * ## 测试策略
 *
 * `reload()` 现在返回「是否真的拿到了设置」，并把结果写进 `loadFailed`。
 * 这里 mock `~/logic/bridge` 来制造「拿不到」的情形，断言界面给出的是
 * **失败 + 重试**，而不是继续转圈。
 */

const mocks = vi.hoisted(() => ({
  app: null as unknown as { value: unknown },
  ai: null as unknown as { value: unknown },
  loadFailed: null as unknown as { value: boolean },
  /** `reload()` 的返回值：`false` = 拿不到设置 */
  reloadOk: true,
  reload: vi.fn(async () => true),
  setApp: vi.fn(async () => {}),
  setAi: vi.fn(async () => {}),
}))

vi.mock('~/logic/bridge', () => ({
  useSettings: () => ({
    app: mocks.app,
    ai: mocks.ai,
    loadFailed: mocks.loadFailed,
    reload: mocks.reload,
    setApp: mocks.setApp,
    setAi: mocks.setAi,
  }),
  // 下面这些是各页组件在挂载时会碰到的，给最小可用实现即可
  useAccounts: () => ({
    accounts: ref([]),
    reload: vi.fn(async () => {}),
    save: vi.fn(async () => true),
    remove: vi.fn(async () => {}),
    test: vi.fn(),
    resetCursor: vi.fn(),
    authorizeGmail: vi.fn(),
    syncNow: vi.fn(async () => ({ started: true })),
    syncStatus: vi.fn(async () => null),
  }),
  useMailTypes: () => ({
    adapters: ref([]),
    reload: vi.fn(async () => {}),
  }),
  onDataChanged: () => () => {},
  onSyncDone: () => () => {},
  useMails: () => ({
    mails: ref([]),
    loading: ref(false),
    justCopied: ref(null),
    copyCode: vi.fn(),
    setRead: vi.fn(),
    dismiss: vi.fn(),
    trash: vi.fn(),
    markAllRead: vi.fn(),
  }),
  useTrash: () => ({
    mails: ref([]),
    loading: ref(false),
    reload: vi.fn(async () => {}),
    restore: vi.fn(),
    deleteForever: vi.fn(),
    empty: vi.fn(),
  }),
  send: vi.fn(async () => ({ providers: [], platforms: [], usage: { count: 0, bytesApprox: 0 } })),
}))

vi.mock('~/logic/ui-message', () => ({
  useAppMessage: () => ({ info: vi.fn(), success: vi.fn(), warning: vi.fn(), error: vi.fn(), loading: vi.fn(), open: vi.fn(), destroy: vi.fn() }),
  ERROR_DURATION: 8,
  WARNING_DURATION: 6,
}))

let Options: import('vue').Component
beforeAll(async () => {
  Options = (await import('~/options/Options.vue')).default
})

function setSettings(appValue: unknown, failed: boolean) {
  mocks.app = ref(appValue)
  mocks.ai = ref(appValue ? { apiKey: '', platform: 'deepseek' } : null)
  mocks.loadFailed = ref(failed)
}

function mountPage() {
  return mount(Options, { attachTo: document.body })
}

beforeEach(() => {
  mocks.reload.mockClear()
  mocks.reload.mockResolvedValue(true)
  localStorage.clear()
})

describe('设置页的加载失败', () => {
  it('还在加载（没有失败）→ 显示转圈，不显示失败页', () => {
    setSettings(null, false)
    const wrapper = mountPage()

    expect(wrapper.find('.ant-spin').exists()).toBe(true)
    expect(wrapper.find('.load-failed').exists()).toBe(false)

    wrapper.unmount()
  })

  it('加载失败 → 显示失败说明 + 重试，且**不再转圈**', () => {
    setSettings(null, true)
    const wrapper = mountPage()

    const failed = wrapper.find('.load-failed')
    expect(failed.exists()).toBe(true)
    expect(failed.text()).toContain('读取设置失败')
    // ⚠ 关键：失败时不能还在转圈
    expect(wrapper.find('.ant-spin').exists()).toBe(false)

    wrapper.unmount()
  })

  it('失败页上的「重试」会再拉一次设置', async () => {
    setSettings(null, true)
    const wrapper = mountPage()

    const retry = wrapper.findAll('button').find(node => node.text().replace(/\s+/g, '') === t('common.retry'))
    expect(retry).toBeDefined()

    await retry!.trigger('click')
    expect(mocks.reload).toHaveBeenCalled()

    wrapper.unmount()
  })

  it('加载成功 → 正常渲染页面，既没有失败页也没有转圈', () => {
    setSettings({ minimalMode: true, mailRetention: 100, excludeAds: false, autoDeleteExpiredCode: true }, false)
    const wrapper = mountPage()

    expect(wrapper.find('.load-failed').exists()).toBe(false)
    expect(wrapper.find('.loading').exists()).toBe(false)
    // 左侧导航渲染出来了就说明进入了正常页面
    expect(wrapper.find('.ant-menu').exists()).toBe(true)

    wrapper.unmount()
  })
})
