import type { Mail } from '~/logic/types'
import { describe, expect, it, vi } from 'vitest'
import { useTrashConfirm } from '../trash-confirm'

/*
 * `useTrashConfirm().confirm()` **必须把删除结果报出来**。
 *
 * 起因：它以前是 `await perform(mail)` 然后什么都不做，把 `perform` 的返回值丢掉。
 * 而 `useMails().trash` 特意返回了 `result.ok`（`trash:trash` 在邮件已经不在库里时
 * 返回 `{ ok: false, error }`）。于是：
 *
 *   - 弹窗**先关再执行**（这是刻意的，见源码注释）；
 *   - 删除失败时弹窗已经关了、邮件还在列表里、**没有任何提示**；
 *   - 用户看到的就是「点了确认，什么都没发生」。
 *
 * 所以这里断言的是返回值语义，让调用方有东西可判断。
 */

function mail(patch: Partial<Mail> = {}): Mail {
  return {
    id: 'm1',
    accountId: 'a1',
    from: { name: '服务', address: 'no-reply@example.com' },
    to: [],
    subject: '你的验证码',
    date: Date.now(),
    ...patch,
  } as Mail
}

describe('删除确认的结果', () => {
  it('删除成功 → confirm() 返回 true', async () => {
    const perform = vi.fn(async (_mail: Mail) => true)
    const { ask, confirm } = useTrashConfirm(perform)

    ask(mail())
    expect(await confirm()).toBe(true)
    expect(perform).toHaveBeenCalledTimes(1)
  })

  it('删除失败（perform 给 false）→ confirm() 返回 false，调用方才有机会提示', async () => {
    const perform = vi.fn(async (_mail: Mail) => false)
    const { ask, confirm } = useTrashConfirm(perform)

    ask(mail())
    expect(await confirm()).toBe(false)
  })

  /*
   * 有些调用方不关心结果（形参类型允许 `void`）—— 那种情况按成功处理，
   * 否则会变成一个永远弹「删除失败」的误报。
   */
  it('perform 不返回结果（void）→ 按成功处理', async () => {
    const perform = vi.fn((_mail: Mail) => {})
    const { ask, confirm } = useTrashConfirm(perform)

    ask(mail())
    expect(await confirm()).toBe(true)
  })

  it('没有待确认的邮件时 → 不执行、返回 false', async () => {
    const perform = vi.fn(async (_mail: Mail) => true)
    const { confirm } = useTrashConfirm(perform)

    expect(await confirm()).toBe(false)
    expect(perform).not.toHaveBeenCalled()
  })

  it('确认后弹窗一定关掉 —— 即使 perform 抛错也不该卡住', async () => {
    const perform = vi.fn(async (_mail: Mail) => {
      throw new Error('boom')
    })
    const { ask, confirm, pending } = useTrashConfirm(perform)

    ask(mail())
    await expect(confirm()).rejects.toThrow('boom')
    // 弹窗先关再执行，所以这里必须是 null
    expect(pending.value).toBeNull()
  })

  it('取消 → 弹窗关掉，不执行任何删除', async () => {
    const perform = vi.fn(async (_mail: Mail) => true)
    const { ask, cancel, pending } = useTrashConfirm(perform)

    ask(mail())
    expect(pending.value).not.toBeNull()
    cancel()
    expect(pending.value).toBeNull()
    expect(perform).not.toHaveBeenCalled()
  })
})
