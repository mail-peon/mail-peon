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
 * ⚠ 这里断的是**颜色档位**（`badge`）与「详情里必须带上原因」，
 *   而不是文案的具体措辞 —— 措辞会改，档位不该改。
 */

/** 只需要状态相关字段的账号 */
function account(patch: Partial<Parameters<typeof accountStatus>[0]> = {}) {
  return { enabled: true, lastError: undefined, lastSyncedAt: undefined, ...patch }
}

const META = { lastSyncText: '14 小时前', cursorText: 'UID 37744' }

describe('账号连接状态的颜色', () => {
  it('从未同步过 → 灰色「未同步」（不能显示成绿色已连接）', () => {
    const status = accountStatus(account(), undefined, META)
    expect(status.status).toBe('default')
    expect(status.label).toBe('未同步')
  })

  it('同步过且没有错误 → 绿色「已连接」，详情给上次同步与位置', () => {
    const status = accountStatus(account({ lastSyncedAt: 1 }), undefined, META)
    expect(status.status).toBe('success')
    expect(status.label).toBe('已连接')
    expect(status.detail).toContain('14 小时前')
    expect(status.detail).toContain('UID 37744')
  })

  it('有 lastError → 红色「同步失败」，详情就是那条错误', () => {
    const error = '无法连接中继：ws://127.0.0.1:8787/imap.qq.com:993?tls=1'
    const status = accountStatus(account({ lastSyncedAt: 1, lastError: error }), undefined, META)
    expect(status.status).toBe('error')
    expect(status.label).toBe('同步失败')
    expect(status.detail).toBe(error)
  })

  it('停用 → 灰色「已停用」，详情说明它不参与同步', () => {
    const status = accountStatus(account({ enabled: false }), undefined, META)
    expect(status.status).toBe('default')
    expect(status.label).toBe('已停用')
    expect(status.detail).toContain('不参与后台同步')
  })

  it('停用但留着一条历史错误 → 仍然红色，并在详情里补一句「已停用」', () => {
    const status = accountStatus(account({ enabled: false, lastError: 'IMAP 超时' }), undefined, META)
    expect(status.status).toBe('error')
    expect(status.detail).toContain('IMAP 超时')
    expect(status.detail).toContain('已停用')
  })
})

describe('操作进行中 / 刚结束的优先级', () => {
  it('连接中 → 黄色「连接中…」（比历史错误更优先）', () => {
    const status = accountStatus(
      account({ lastError: '上一次失败了' }),
      { status: 'busy', text: '测试中…' },
      META,
    )
    expect(status.status).toBe('warning')
    expect(status.detail).toBe('测试中…')
  })

  it('刚测试失败 → 红色「连接失败」，详情用这一次的结果', () => {
    const status = accountStatus(
      account({ lastSyncedAt: 1 }),
      { status: 'fail', text: '中继地址要以 ws:// 开头' },
      META,
    )
    expect(status.status).toBe('error')
    expect(status.label).toBe('连接失败')
    expect(status.detail).toBe('中继地址要以 ws:// 开头')
  })

  it('刚测试成功 → 绿色「已连接」，详情用这一次的结果（例如收件箱封数）', () => {
    const status = accountStatus(
      account({ lastSyncedAt: 1 }),
      { status: 'ok', text: '收件箱有 128 封邮件，UIDVALIDITY 1' },
      META,
    )
    expect(status.status).toBe('success')
    expect(status.detail).toContain('收件箱有 128 封邮件')
  })

  /*
   * ⚠ 「刚测试成功」但没带文案时要退回按账号本身判断，
   *   而不是显示一个空的 tooltip。
   */
  it('测试成功但无文案 → 退回按账号本身判断', () => {
    const status = accountStatus(account({ lastSyncedAt: 1 }), { status: 'ok', text: '' }, META)
    expect(status.status).toBe('success')
    expect(status.detail).toContain('14 小时前')
  })
})
