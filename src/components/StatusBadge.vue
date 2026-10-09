<script setup lang="ts">
import type { UiStatus } from '~/logic/ui-status'

/**
 * 状态徽标：`● 已连接`，鼠标悬停看详情。
 *
 * ## 为什么值得单独一个组件
 *
 * 「坏消息」的呈现方式在项目里统一成了这一件事：
 *
 *   - **颜色**由 `status`（antd Badge 的 `success` / `warning` / `error` / `default`）表达；
 *   - **一句话**由 `label` 表达（要短：它跟标题抢位置）；
 *   - **原因与数字**放 `detail`，悬停才出现。
 *
 * 这样一条报错不再是一整条红色横幅（那会把卡片撑开、把列表推下去，
 * 而且它会一直留在那里），但信息一点没少 —— 只是从「一直在」变成「问它才在」。
 *
 * ⚠ `status` / `label` / `detail` 与 `logic/ui-status.ts` 的 `UiStatusText`
 *   字段名对齐，所以调用方可以 `<StatusBadge v-bind="someStatus" />`。
 *
 * ⚠ `detail` 为空时用 `:open="false"` **关掉** tooltip，而不是让它悬停出一个空气泡
 *   （空气泡看起来像加载失败）。
 */
withDefaults(defineProps<{
  /** 圆点颜色 */
  status?: UiStatus
  /** 圆点右边的状态词 */
  label?: string
  /** 悬停详情；为空则不显示 tooltip */
  detail?: string
  /** tooltip 的方位（卡片右上角用 `topRight` 更贴） */
  placement?: 'top' | 'topLeft' | 'topRight' | 'bottom' | 'bottomLeft' | 'bottomRight' | 'left' | 'leftTop' | 'leftBottom' | 'right' | 'rightTop' | 'rightBottom'
}>(), {
  status: 'default',
  label: '',
  detail: '',
  placement: 'topRight',
})
</script>

<template>
  <a-tooltip :title="detail" :placement="placement" :open="detail ? undefined : false">
    <a-badge :status="status" :text="label" />
  </a-tooltip>
</template>

<style scoped>
/*
 * 状态词小一号、次要色：它是**标识**而不是正文，不该跟卡片标题抢注意力。
 * （`.ant-badge-status-text` 是 antd 的内部类，所以要 `:deep`。）
 */
:deep(.ant-badge-status-text) {
  font-size: 12px;
  color: var(--mp-text-dim);
}
</style>
