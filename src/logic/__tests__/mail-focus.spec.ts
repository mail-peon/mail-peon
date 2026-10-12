import { mount } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { defineComponent, h, nextTick } from 'vue'

/**
 * 「点 toast → 把那封邮件滚到眼前」必须**真的接上**。
 *
 * ## 这一组对应一个只做了一半的功能
 *
 * `contentScripts/toast.ts` 一直在点击整条 toast 时
 * `sendToBackground('mail:focus', { mailId })`，源码注释和 `shim.d.ts` 都写着
 * 「让已经打开的 Popup 滚过去」——
 *
 * 但 `bridge.ts` 的 `installBridgeListener()` 里**没有注册这条通道**，
 * 全项目没有一个 `onMessage('mail:focus')`。于是那个行为一直是
 * 「toast 消失，然后什么也没发生」，而且没有任何线索指向它：
 * 发送端有、类型声明有，只有接收端不存在。
 *
 * ## 测试策略
 *
 * `onMailFocus` 是 `~/logic/bridge` 的出口，这里把它 mock 成一个可手动触发的
 * 登记表 —— 于是「有没有人订阅」变成可测的（这正是当初缺的那一环）。
 */

const mocks = vi.hoisted(() => {
  const focusListeners = new Set<(mailId: string) => void>()
  return {
    focusListeners,
    onMailFocus: vi.fn((listener: (mailId: string) => void) => {
      focusListeners.add(listener)
      return () => focusListeners.delete(listener)
    }),
  }
})

vi.mock('~/logic/bridge', () => ({
  onMailFocus: mocks.onMailFocus,
}))

let useMailFocus: typeof import('~/logic/mail-focus').useMailFocus
beforeEach(async () => {
  vi.resetModules()
  mocks.focusListeners.clear()
  mocks.onMailFocus.mockClear()
  // ⚠ 每次重新 import：composable 里的 `onUnmounted` 需要当前组件实例，
  //   而模块本身有状态（订阅集合），不隔离会互相污染
  useMailFocus = (await import('~/logic/mail-focus')).useMailFocus
})

afterEach(() => {
  document.body.innerHTML = ''
})

/** 用一个最小宿主组件来跑 composable —— `onUnmounted` 必须有组件实例 */
function mountHost() {
  let api: ReturnType<typeof useMailFocus> | null = null
  const Host = defineComponent({
    setup() {
      api = useMailFocus(10_000)
      return () => h('div')
    },
  })
  const wrapper = mount(Host, { attachTo: document.body })
  return { wrapper, api: api as unknown as ReturnType<typeof useMailFocus> }
}

/** 造一条带 `data-mail-id` 的列表项（`MailListItem` 渲染出来的就是这样） */
function seedItem(mailId: string) {
  const el = document.createElement('article')
  el.className = 'mail-item'
  el.dataset.mailId = mailId
  // jsdom 没有 scrollIntoView
  el.scrollIntoView = vi.fn()
  document.body.appendChild(el)
  return el
}

describe('点 toast 定位邮件', () => {
  it('订阅方真的注册上了 —— 这就是当初缺的那一环', () => {
    const { wrapper } = mountHost()
    expect(mocks.onMailFocus).toHaveBeenCalledTimes(1)
    expect(mocks.focusListeners.size).toBe(1)
    wrapper.unmount()
  })

  it('收到 mail:focus → 高亮那一封，并把它滚进视口', async () => {
    const target = seedItem('m2')
    const other = seedItem('m1')

    const { wrapper, api } = mountHost()

    for (const listener of mocks.focusListeners)
      listener('m2')

    await nextTick()
    await nextTick()

    // 高亮的是 m2，不是列表里第一条
    expect(api.focusedId.value).toBe('m2')
    expect(target.scrollIntoView).toHaveBeenCalled()
    expect(other.scrollIntoView).not.toHaveBeenCalled()

    wrapper.unmount()
  })

  it('邮件不在 DOM 里时不抛错（可能已经被清掉了）', async () => {
    const { wrapper, api } = mountHost()

    expect(() => {
      for (const listener of mocks.focusListeners)
        listener('not-here')
    }).not.toThrow()

    await nextTick()
    // 仍然记下 id（高亮状态本身不依赖 DOM），只是没得滚
    expect(api.focusedId.value).toBe('not-here')

    wrapper.unmount()
  })

  it('高亮会自己消失（不会永久留在那儿）', async () => {
    vi.useFakeTimers()
    const { wrapper, api } = mountHost()
    // 这条用例要的是「会清掉」，用默认 2.4s 太长，直接快进
    for (const listener of mocks.focusListeners)
      listener('m1')
    expect(api.focusedId.value).toBe('m1')

    vi.advanceTimersByTime(60_000)
    expect(api.focusedId.value).toBeNull()

    vi.useRealTimers()
    wrapper.unmount()
  })

  it('重新定位另一封时，上一条的高亮被顶掉（不会同时亮两条）', async () => {
    const { wrapper, api } = mountHost()

    for (const listener of mocks.focusListeners)
      listener('m1')
    for (const listener of mocks.focusListeners)
      listener('m2')

    expect(api.focusedId.value).toBe('m2')

    wrapper.unmount()
  })

  it('组件卸载后取消订阅 —— 否则消息会打到已销毁的组件上', () => {
    const { wrapper } = mountHost()
    expect(mocks.focusListeners.size).toBe(1)

    wrapper.unmount()
    expect(mocks.focusListeners.size).toBe(0)
  })
})
