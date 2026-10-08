/**
 * 时间点的展示格式化。
 *
 * 单独一个模块（而不是放在 `CodeCountdown.vue` 的 `<script setup>` 里）有两个理由：
 *
 *   1. ⚠ **`<script setup>` 里不能写 `export`** —— Vue 会直接编译失败：
 *      「`<script setup> cannot contain ES module exports`」。
 *      而这段逻辑需要单测覆盖（日期边界很难靠挂载组件来验），所以必须能导出。
 *   2. 「当天只给时分秒、跨天给完整日期」是一条**展示约定**，
 *      将来别的界面（比如邮件详情）要用同一套规则时不该复制一份。
 */

/**
 * 格式化一个时间点：**当天** `HH:mm:ss`，**跨天** `YYYY-MM-DD HH:mm:ss`。
 *
 * 为什么这样分（产品要求）：同一个自然日内，用户读到 `14:30:05` 就知道是刚才的事；
 * 而跨天时只给时分秒会产生歧义（「23:59:00」到底是昨天还是今天？），
 * 所以补上完整日期。
 *
 * ⚠ 判断「是不是当天」用的是**本地日历日**（`getFullYear/Month/Date`），
 *   不是「相差 24 小时以内」。用户说的「当天」是日历概念：
 *   23:59 失效、次日 00:01 查看 —— 只差 2 分钟，但已经是两天了。
 *
 * ⚠ 一律补零到 2 位、24 小时制。这是**机器时间戳**，不是给人念的自然语言
 *   （列表里的「1 小时前」走的是另一条相对时间路径）。
 *
 * @param timestamp 要格式化的时刻
 * @param reference 用来比较「今天」的参照时刻（默认现在；测试可注入）
 * @returns 展示用时间串
 */
export function formatTimestamp(timestamp: number, reference: number = Date.now()): string {
  const at = new Date(timestamp)
  const today = new Date(reference)

  const sameDay = at.getFullYear() === today.getFullYear()
    && at.getMonth() === today.getMonth()
    && at.getDate() === today.getDate()

  const time = `${pad(at.getHours())}:${pad(at.getMinutes())}:${pad(at.getSeconds())}`
  if (sameDay)
    return time

  const date = `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`
  return `${date} ${time}`
}

/**
 * 补零到 2 位。
 *
 * @param value 数字
 * @returns 至少两位的字符串
 */
function pad(value: number): string {
  return String(value).padStart(2, '0')
}
