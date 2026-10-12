import type { Mail } from '~/logic/types'
import { mount } from '@vue/test-utils'
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { ref } from 'vue'

/**
 * 回收站页的动作按钮**每一个都必须真的接上了函数**。
 *
 * ## 这一组对应一个真机上必然复现的崩溃
 *
 * 这一页曾经有三个动作按钮，中间那个是「移入回收站」。但：
 *
 *   - 它调的是 `trash(mail)`，而 `useTrash()` **从来没有返回过 `trash`**
 *     （那个函数属于 `useMails`，是弹窗/侧边栏用的）→ `TypeError: trash is not a function`；
 *   - `withBusy` 当时只有 `finally` 没有 `catch` → 弹窗关掉、界面零变化、零报错，
 *     异常只在 devtools 里变成 unhandled rejection；
 *   - 而 `.vue` 不在 `tsc` 的检查范围内（见 `global.d.ts` 的 `*.vue` 声明），
 *     单测又整体 mock 了 `~/logic/bridge`，两个环节都没拦住。
 *
 * ## 测试策略
 *
 * 不去模拟 `webext-bridge`，而是把 `~/logic/bridge` 整个 mock 掉，只保留接口语义。
 * 关键是：**假 `useTrash()` 按真实返回值给**（`bridge.ts` 的 `useTrash`）——
 * 于是「组件解构了一个不存在的键」会立刻表现为「点了按钮，期望的 mock 没被调用」。
 */

const mocks = vi.hoisted(() => ({
  mails: null as unknown as { value: Mail[] },
  /*
   * ⚠ 形参必须显式写出来（`_mail: Mail`），否则 `vi.fn(async () => true)` 推出的是
   *   零参函数，`mock.calls[0][0]` 就成了「长度为 0 的元组取下标 0」——
   *   测试跑得通，但 `tsc` 报 TS2493。
   */
  restore: vi.fn(async (_mail: Mail) => true),
  deleteForever: vi.fn(async (_mail: Mail) => true),
  empty: vi.fn(async () => 0),
  setApp: vi.fn(async () => {}),
}))

vi.mock('~/logic/bridge', () => ({
  /*
   * ⚠ 返回的键**必须与 `bridge.ts` 的 `useTrash()` 一字不差**。
   *   这里多给一个键，就等于帮组件把它那个拼错的解构藏起来了 ——
   *   而这正是被测的那个 bug。
   */
  useTrash: () => ({
    mails: mocks.mails,
    loading: ref(false),
    reload: vi.fn(async () => {}),
    restore: mocks.restore,
    deleteForever: mocks.deleteForever,
    empty: mocks.empty,
  }),
  useSettings: () => ({
    app: ref({ autoDeleteExpiredCode: true }),
    setApp: mocks.setApp,
  }),
}))

vi.mock('~/logic/ui-message', () => ({
  useAppMessage: () => ({ info: vi.fn(), success: vi.fn(), warning: vi.fn(), error: vi.fn(), loading: vi.fn(), open: vi.fn(), destroy: vi.fn() }),
  ERROR_DURATION: 8,
  WARNING_DURATION: 6,
}))

let TrashPage: import('vue').Component
beforeAll(async () => {
  // 必须在 `vi.mock` 之后动态 import（`vi.mock` 与静态 import 都会被提升，顺序要钉死）
  TrashPage = (await import('~/options/pages/TrashPage.vue')).default
})

function mail(patch: Partial<Mail> = {}): Mail {
  return {
    id: 'm1',
    accountId: 'a1',
    from: { name: '服务', address: 'no-reply@example.com' },
    to: [],
    subject: '你的验证码',
    date: Date.now(),
    code: '123456',
    trashedAt: Date.now() - 60_000,
    ...patch,
  } as Mail
}

function mountPage(mails: Mail[] = [mail()]) {
  mocks.mails = ref(mails) as unknown as { value: Mail[] }
  return mount(TrashPage, { attachTo: document.body })
}

/** 表格某一行里的按钮（按可见文字找，antd 会在两个汉字的按钮里插空格，所以去空白） */
function rowButton(wrapper: ReturnType<typeof mountPage>, text: string) {
  return wrapper.findAll('button').find(node => node.text().replace(/\s+/g, '').includes(text))
}

/**
 * 点确认弹窗里的「确认」。
 *
 * ⚠ 两条容易踩的：
 *   1. 确认按钮的文案是调用方传的 `confirmText`（这里是「彻底删除」/「清空回收站」），
 *      **不是**「确认」—— 按文字找会找不着；
 *   2. `ConfirmDialog` 用了 `:get-container="false"`，弹窗**不 portal**、就在 wrapper 里，
 *      所以 `wrapper.find('.dialog')` 能拿到（antd 把 `class` 落在 `.ant-modal` 上）。
 */
async function confirmDialog(wrapper: ReturnType<typeof mountPage>) {
  await new Promise(resolve => setTimeout(resolve, 0))
  await wrapper.vm.$nextTick()

  const dialog = wrapper.find('.dialog')
  if (!dialog.exists())
    throw new Error('确认弹窗没出现 —— `useConfirmAction` / `ConfirmDialog` 的交互改了？')

  await dialog.find('button.ant-btn-primary').trigger('click')
  await new Promise(resolve => setTimeout(resolve, 0))
}

beforeEach(() => {
  mocks.restore.mockClear()
  mocks.deleteForever.mockClear()
  mocks.empty.mockClear()
  mocks.setApp.mockClear()
  mocks.restore.mockResolvedValue(true)
  mocks.deleteForever.mockResolvedValue(true)
  mocks.empty.mockResolvedValue(0)
})

describe('回收站页的动作按钮', () => {
  it('每一行只有「恢复」和「彻底删除」两个动作 —— 没有第三个按钮', () => {
    const wrapper = mountPage()

    const actions = wrapper.find('.ant-table-tbody')
    expect(actions.exists()).toBe(true)

    const labels = wrapper.findAll('.ant-table-tbody button').map(node => node.text().replace(/\s+/g, ''))
    expect(labels).toContain('恢复')
    expect(labels).toContain('彻底删除')
    // ⚠ 就是这一条守住那个 bug：多出来的「移入回收站」曾经在这里，而且点了必崩
    expect(labels).toHaveLength(2)

    wrapper.unmount()
  })

  it('点「恢复」直接执行（非破坏性，不弹确认）', async () => {
    const wrapper = mountPage()
    await rowButton(wrapper, '恢复')!.trigger('click')
    await new Promise(resolve => setTimeout(resolve, 0))

    expect(mocks.restore).toHaveBeenCalledTimes(1)
    expect(mocks.restore.mock.calls[0][0]).toMatchObject({ id: 'm1' })
    // 恢复不该顺手把邮件彻底删掉
    expect(mocks.deleteForever).not.toHaveBeenCalled()

    wrapper.unmount()
  })

  it('点「彻底删除」要确认，确认后才真的删', async () => {
    const wrapper = mountPage()
    await rowButton(wrapper, '彻底删除')!.trigger('click')
    await confirmDialog(wrapper)

    expect(mocks.deleteForever).toHaveBeenCalledTimes(1)
    expect(mocks.deleteForever.mock.calls[0][0]).toMatchObject({ id: 'm1' })

    wrapper.unmount()
  })

  it('点「清空回收站」要确认，确认后才真的清', async () => {
    const wrapper = mountPage()
    await rowButton(wrapper, '清空回收站')!.trigger('click')
    await confirmDialog(wrapper)

    expect(mocks.empty).toHaveBeenCalledTimes(1)

    wrapper.unmount()
  })

  /*
   * 这条守的是 `withBusy` 的 `catch`。
   * 没有它的话，动作抛错时界面**零变化零报错** —— 用户只会觉得「点了没反应」。
   */
  it('动作抛错 → 页面上给出可见的失败提示，而不是静默', async () => {
    mocks.restore.mockRejectedValueOnce(new Error('中继断了'))
    const wrapper = mountPage()

    await rowButton(wrapper, '恢复')!.trigger('click')
    await new Promise(resolve => setTimeout(resolve, 0))
    await wrapper.vm.$nextTick()

    expect(wrapper.find('.notice').text()).toContain('中继断了')

    wrapper.unmount()
  })

  it('回收站为空时不渲染任何行内动作按钮', () => {
    const wrapper = mountPage([])
    expect(wrapper.findAll('.ant-table-tbody button')).toHaveLength(0)
    wrapper.unmount()
  })
})
