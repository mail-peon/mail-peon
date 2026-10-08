<script setup lang="ts">
import { nextTick, onUnmounted, ref, watch } from 'vue'

/**
 * 确认弹窗。
 *
 * ## 为什么不用原生 `confirm()`
 *
 * 1. **它是同步阻塞的** —— 会让整个页面卡住（Vue 的更新也排在它后面），
 *    在 Options 这种长页面上尤其明显；
 * 2. **没法自定义**：按钮文案只能是「确定 / 取消」，
 *    而「彻底删除」这类动作值得把后果写在按钮上；
 * 3. **样式与产品完全脱节**，在深色主题下尤其突兀。
 *
 * ## 为什么不用「两步按钮」
 *
 * 试过（「清空回收站」→「再点一次，彻底删除」）。它的问题是**没有信息量**：
 * 第二次点击时用户看到的还是同一个按钮附近，看不到「即将删掉几封」这类关键信息。
 * 而弹窗可以把后果写在正文里，并且**必须**做一个明确的选择（不能顺手连点两下）。
 *
 * ## 行为约定
 *
 * - 按 `Escape` = 取消（`cancel` 事件）；
 * - 点遮罩 = 取消（危险操作不该因为「点偏了」而执行）；
 * - 点弹窗本体 = 什么都不做（`@click.stop`）；
 * - `danger` 为真时确认按钮是红色（`mp-btn-danger`）。
 *
 * ⚠ 弹窗本身**不做**任何业务判断 —— 它只回答「用户点了哪个按钮」。
 *   把「该不该确认」留在调用方：这个组件不该知道什么是回收站。
 */

const props = withDefaults(defineProps<{
  /** 是否显示 */
  open: boolean
  /** 标题 */
  title: string
  /** 正文（说明后果） */
  message?: string
  /** 确认按钮文案 */
  confirmText?: string
  /** 取消按钮文案 */
  cancelText?: string
  /** 危险操作：确认按钮用红色 */
  danger?: boolean
}>(), {
  message: '',
  confirmText: '确定',
  cancelText: '取消',
  danger: false,
})

const emit = defineEmits<{
  confirm: []
  cancel: []
}>()

/** 取消按钮 —— 打开时把焦点放上去（见模板里的说明） */
const cancelRef = ref<HTMLButtonElement | null>(null)

/**
 * `Escape` 键处理。
 *
 * ⚠ 只在 `open` 为真时挂监听，关闭时立刻摘掉 ——
 *   常驻一个全局 keydown 监听会让「按 Esc」在弹窗之外也触发取消逻辑，
 *   而调用方拿到的是一次莫名其妙的 `cancel`。
 *
 * ⚠ 用 `capture` 阶段：页面里可能有别的组件（输入框等）也在听 keydown，
 *   冒泡阶段可能被它们 `stopPropagation` 掉，于是 Esc 失效。
 */
function onKeydown(event: KeyboardEvent) {
  if (event.key === 'Escape') {
    event.stopPropagation()
    emit('cancel')
  }
}

watch(() => props.open, async (open) => {
  if (!open) {
    globalThis.removeEventListener('keydown', onKeydown, true)
    return
  }

  globalThis.addEventListener('keydown', onKeydown, true)
  // 等 DOM 真的渲染出来再聚焦（`v-if` 之下这一帧按钮还不存在）
  await nextTick()
  cancelRef.value?.focus()
}, { immediate: true })

// 组件被卸载时（例如在回收站里操作后列表重渲染）也要摘掉
onUnmounted(() => {
  globalThis.removeEventListener('keydown', onKeydown, true)
})
</script>

<template>
  <!--
    ⚠ 用 `v-if` 而不是 `v-show` + `visibility`：
       隐藏的弹窗不该留在 DOM 里参与 Tab 顺序，否则用户按 Tab 会「跳进一个看不见的弹窗」。
  -->
  <div v-if="open" class="overlay" @click="emit('cancel')">
    <div
      class="dialog mp-card"
      role="alertdialog"
      aria-modal="true"
      :aria-label="title"
      @click.stop
    >
      <p class="title">
        {{ title }}
      </p>
      <p v-if="message" class="message">
        {{ message }}
      </p>

      <div class="actions">
        <!--
          ⚠ 焦点**先给取消按钮**，不是确认按钮。
            危险操作的默认焦点必须在「不删」那一侧 —— 否则用户习惯性敲回车
            就会把邮件删掉。这是「弹窗确认」相对「两步按钮」唯一可能更糟的地方，
            所以在这里补上。
        -->
        <button ref="cancelRef" class="mp-btn" type="button" @click="emit('cancel')">
          {{ cancelText }}
        </button>
        <button
          class="mp-btn"
          :class="danger ? 'mp-btn-danger' : 'mp-btn-primary'"
          type="button"
          @click="emit('confirm')"
        >
          {{ confirmText }}
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.overlay {
  position: fixed;
  inset: 0;
  z-index: 1000;
  display: flex;
  align-items: center;
  justify-content: center;
  /*
   * 半透明遮罩：同时起两个作用 —— 视觉上聚焦到弹窗，
   * 以及**截获点击**（点到外面 = 取消，不会误触到下面的列表）。
   */
  background: rgba(0, 0, 0, 0.45);
  padding: 20px;
}

.dialog {
  width: 100%;
  max-width: 320px;
  /* 覆盖 `.mp-card` 的默认间距：弹窗内部要自己控制节奏 */
  margin: 0;
}

.title {
  margin: 0 0 6px;
  font-size: 13px;
  font-weight: 600;
  color: var(--mp-text);
}

.message {
  margin: 0;
  font-size: 12px;
  line-height: 1.5;
  color: var(--mp-text-dim);
  /* 长文案（例如带邮件标题）要能换行，不能撑破弹窗 */
  overflow-wrap: anywhere;
}

.actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  margin-top: 14px;
}
</style>
