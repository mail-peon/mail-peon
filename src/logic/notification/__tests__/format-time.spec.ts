import { describe, expect, it } from 'vitest'
import { formatTimestamp } from '~/logic/notification/format-time'

/**
 * 时间点格式化的测试。
 *
 * ## 规则（产品要求）
 *
 * - **当天** → `HH:mm:ss`
 * - **跨天** → `YYYY-MM-DD HH:mm:ss`
 *
 * 这条规则用在「验证码已失效」那一行：只写「失效」不告诉用户**什么时候**失效的，
 * 而那决定了「还有没有救」。
 *
 * ⚠ 这里全部用**显式构造的本地时间**（`new Date(y, m, d, h, mi, s)`）而不是
 *   ISO 字符串：后者带时区偏移，会让断言随运行机器的时区变化 ——
 *   那种测试在 CI 上绿、在别人机器上红。
 */

/** 构造本地时刻，避免时区依赖 */
function at(year: number, month: number, day: number, hour = 0, minute = 0, second = 0): number {
  return new Date(year, month - 1, day, hour, minute, second).getTime()
}

describe('formatTimestamp：当天只给时分秒', () => {
  it('同一天 → HH:mm:ss', () => {
    const reference = at(2026, 10, 9, 15, 30, 0)
    expect(formatTimestamp(at(2026, 10, 9, 14, 30, 5), reference)).toBe('14:30:05')
  })

  it('补零到 2 位', () => {
    const reference = at(2026, 10, 9, 23, 59, 59)
    expect(formatTimestamp(at(2026, 10, 9, 0, 0, 0), reference)).toBe('00:00:00')
    expect(formatTimestamp(at(2026, 10, 9, 9, 5, 3), reference)).toBe('09:05:03')
  })

  it('24 小时制（下午 1 点 = 13 点）', () => {
    const reference = at(2026, 10, 9, 23, 0, 0)
    expect(formatTimestamp(at(2026, 10, 9, 13, 0, 0), reference)).toBe('13:00:00')
  })
})

describe('formatTimestamp：跨天给完整日期', () => {
  it('昨天 → YYYY-MM-DD HH:mm:ss', () => {
    const reference = at(2026, 10, 9, 12, 0, 0)
    expect(formatTimestamp(at(2026, 10, 8, 14, 30, 5), reference)).toBe('2026-10-08 14:30:05')
  })

  it('明天（时钟跳变 / 导入数据）也给完整日期', () => {
    const reference = at(2026, 10, 9, 12, 0, 0)
    expect(formatTimestamp(at(2026, 10, 10, 1, 2, 3), reference)).toBe('2026-10-10 01:02:03')
  })

  it('跨年', () => {
    const reference = at(2026, 1, 1, 0, 30, 0)
    expect(formatTimestamp(at(2025, 12, 31, 23, 59, 59), reference)).toBe('2025-12-31 23:59:59')
  })

  it('月份与日期都补零', () => {
    const reference = at(2026, 11, 20, 12, 0, 0)
    expect(formatTimestamp(at(2026, 1, 5, 6, 7, 8), reference)).toBe('2026-01-05 06:07:08')
  })
})

describe('formatTimestamp：「当天」按日历日判断，不是按 24 小时', () => {
  /*
   * ⚠ 这一组是这条规则最容易写错的地方。
   *
   *   用「相差是否小于 24 小时」来判断的话，下面第一条会算成「同一天」——
   *   但 23:59 失效、次日 00:01 查看，明明已经是**两天**了，
   *   只显示 `23:59:00` 会让用户以为那是今天晚上的事。
   */
  it('相差 2 分钟但跨了自然日 → 给完整日期', () => {
    const reference = at(2026, 10, 10, 0, 1, 0)
    expect(formatTimestamp(at(2026, 10, 9, 23, 59, 0), reference)).toBe('2026-10-09 23:59:00')
  })

  it('相差近 24 小时但在同一自然日 → 只给时分秒', () => {
    const reference = at(2026, 10, 9, 23, 59, 0)
    expect(formatTimestamp(at(2026, 10, 9, 0, 1, 0), reference)).toBe('00:01:00')
  })
})

describe('formatTimestamp：默认参照时刻是现在', () => {
  it('不传 reference 时用 Date.now()', () => {
    const now = Date.now()
    // 5 秒前必定是「今天」（除非正好跨过午夜，那时会走到完整日期分支）
    const result = formatTimestamp(now - 5000)
    expect(result).toMatch(/^(\d{2}:\d{2}:\d{2}|\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})$/)
  })
})
