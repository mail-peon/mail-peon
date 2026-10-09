import type { AccountStatusInput } from '~/options/pages/accounts-status'
import { describe, expect, it } from 'vitest'
import { accountStatus } from '~/options/pages/accounts-status'

/**
 * 账号卡片的连接状态（颜色策略）。
 *
 * ## 为什么值得单测
 *
 * 「什么情况显示什么颜色」在界面上几乎验证不了：一个出错账号与正常账号的 DOM
 * 差别只是一个 `ant-badge-status-*` class。而它错了的后果是**误导** ——
 * 例如把一个连不上的账号显示成绿色「已连接」，用户就不会去查。
 *
 * ⚠ 这里断的是**颜色档位**（`status`）、**状态词该说的是什么**，
 *   以及「详情里必须带上原因」；不锁具体措辞（措辞会改，档位不该改）。
 */

/** 只需要状态相关字段的账号 */
function account(patch: Partial<AccountStatusInput['account']> = {}) {
  return { enabled: true, lastError: undefined, lastSyncedAt: undefined, ...patch }
}

const META = { lastSyncText: '14 小时前', cursorText: 'UID 37744' }

/** 调用简写（本文件里绝大多数用例只关心 probe / busy 这两个输入） */
function status(
  acc: Partial<AccountStatusInput['account']> = {},
  extra: { probe?: AccountStatusInput['probe'], busy?: AccountStatusInput['busy'] } = {},
) {
  return accountStatus({ account: account(acc), probe: extra.probe, busy: extra.busy, meta: META })
}

describe('账号连接状态的颜色', () => {
  it('从未同步过 → 灰色「未同步」（不能显示成绿色已连接）', () => {
    const s = status()
    expect(s.status).toBe('default')
    expect(s.label).toBe('未同步')
  })

  it('同步过且没有错误 → 绿色「已连接」，详情给上次同步与位置', () => {
    const s = status({ lastSyncedAt: 1 })
    expect(s.status).toBe('success')
    expect(s.label).toBe('已连接')
    expect(s.detail).toContain('14 小时前')
    expect(s.detail).toContain('UID 37744')
  })

  it('有 lastError → 红色「同步失败」，详情就是那条错误', () => {
    const error = '无法连接中继：ws://127.0.0.1:8787/imap.qq.com:993?tls=1'
    const s = status({ lastSyncedAt: 1, lastError: error })
    expect(s.status).toBe('error')
    expect(s.label).toBe('同步失败')
    expect(s.detail).toBe(error)
  })

  it('停用 → 灰色「已停用」，详情说明它不参与同步', () => {
    const s = status({ enabled: false })
    expect(s.status).toBe('default')
    expect(s.label).toBe('已停用')
    expect(s.detail).toContain('不参与后台同步')
  })

  it('停用但留着一条历史错误 → 仍然红色，并在详情里补一句「已停用」', () => {
    const s = status({ enabled: false, lastError: 'IMAP 超时' })
    expect(s.status).toBe('error')
    expect(s.detail).toContain('IMAP 超时')
    expect(s.detail).toContain('已停用')
  })
})

describe('测试连接的结果（probe）', () => {
  it('刚测试失败 → 红色「连接失败」，详情用这一次的结果', () => {
    const s = status({ lastSyncedAt: 1 }, { probe: { ok: false, text: '中继地址要以 ws:// 开头' } })
    expect(s.status).toBe('error')
    expect(s.label).toBe('连接失败')
    expect(s.detail).toBe('中继地址要以 ws:// 开头')
  })

  it('刚测试成功 → 绿色「已连接」，详情用这一次的结果（例如收件箱封数）', () => {
    const s = status({ lastSyncedAt: 1 }, { probe: { ok: true, text: '收件箱有 128 封邮件，UIDVALIDITY 1' } })
    expect(s.status).toBe('success')
    expect(s.detail).toContain('收件箱有 128 封邮件')
  })

  /*
   * ⚠ 「刚测试成功」但没带文案时要退回按账号本身判断，
   *   而不是显示一个空的 tooltip。
   */
  it('测试成功但无文案 → 退回按账号本身判断', () => {
    const s = status({ lastSyncedAt: 1 }, { probe: { ok: true, text: '' } })
    expect(s.status).toBe('success')
    expect(s.detail).toContain('14 小时前')
  })

  it('探测失败比历史错误更近：两者都有时用探测的结果', () => {
    const s = status(
      { lastError: '上一次失败了' },
      { probe: { ok: false, text: '刚刚又试了一次：连接超时' } },
    )
    expect(s.detail).toBe('刚刚又试了一次：连接超时')
  })
})

/**
 * ⚠⚠ 这一组对应真机 bug：「点『重置同步位置』，转圈的是『测试连接』」。
 *
 * 根因是把「哪个操作在忙」和「上一个结果是什么」塞进了同一个槽位，
 * 于是按钮的 loading 判据只看得到后者。修法是把 `busy` 单独传进来、
 * 并且**带上操作的种类** —— 顺手也修掉了「黄灯只会说『连接中…』」这件事：
 * 重置的时候根本没在连接。
 */
describe('耗时操作进行中（busy）', () => {
  it('正在测试连接 → 黄色「测试中…」', () => {
    const s = status({ lastSyncedAt: 1 }, { busy: 'test' })
    expect(s.status).toBe('warning')
    expect(s.label).toBe('测试中…')
  })

  it('正在重置同步位置 → 黄色「重置中…」，而不是「连接中…」', () => {
    const s = status({ lastSyncedAt: 1 }, { busy: 'reset' })
    expect(s.status).toBe('warning')
    expect(s.label).toBe('重置中…')
    expect(s.label).not.toContain('连接')
    expect(s.detail).not.toContain('连接')
  })

  it('进行中优先于历史错误与上一次探测结果', () => {
    const s = status(
      { lastError: '上次同步失败' },
      { busy: 'reset', probe: { ok: false, text: '上次测试失败' } },
    )
    expect(s.status).toBe('warning')
    expect(s.label).toBe('重置中…')
  })
})
