/**
 * 界面上的「状态徽标」：一个圆点 + 一句短状态词 + 悬停详情。
 *
 * ## 为什么要有这套约定
 *
 * 项目里有好几处「某个东西现在是好是坏」：账号能不能连上、AI 配置通不通。
 * 它们在界面上长得应该一样（圆点颜色 + 一句状态词 + 悬停看原因），
 * 否则用户要为每处重新学一遍「这个颜色是什么意思」。
 *
 * 所以把**判据**（什么时候红/黄/绿）留在各自的模块里
 * （例如 `options/pages/accounts-status.ts`），把**呈现**交给
 * `components/StatusBadge.vue`，两边用这个类型对接。
 *
 * ⚠ 返回的对象字段名与 `StatusBadge` 的 props **完全对齐**，
 *   于是调用方可以 `<StatusBadge v-bind="status" />` —— 少写一层映射，
 *   也就少一处「加了字段忘了传」的机会。
 */

/** 圆点颜色（就是 antd `Badge` 的 `status`） */
export type UiStatus = 'success' | 'warning' | 'error' | 'default'

export interface UiStatusText {
  /** 圆点颜色 */
  status: UiStatus
  /** 圆点右边的状态词（要短，长了会把标题挤走） */
  label: string
  /** 悬停时 tooltip 里的详情：把原因、数字、后果说清楚 */
  detail: string
}
