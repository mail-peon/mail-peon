<script setup lang="ts">
import { nextTick, onUnmounted, ref, watch } from 'vue'

/**
 * 确认弹窗（基于 antd 的 `Modal`）。
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
 * - 点弹窗本体 = 什么都不做；
 * - `danger` 为真时确认按钮是红色（antd 的 `danger`）。
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

/**
 * 取消按钮 —— 打开时把焦点放上去（见下面的说明）。
 *
 * ⚠ 类型是「有 `$el` 的东西」而不是 `HTMLButtonElement`：
 *   它绑在 `<a-button>` 这个**组件**上，拿到的就是组件实例，
 *   真正的 `<button>` 在 `$el` 里。
 */
const cancelRef = ref<{ $el?: HTMLElement } | null>(null)

function focusCancel() {
  cancelRef.value?.$el?.focus()
}

/**
 * `Escape` 键处理。
 *
 * ⚠ 只用**我们自己**这一条监听（`<a-modal :keyboard="false">`），
 *   不能两套都留：antd 的 Dialog 也在 wrap 上听 Esc，两边都开着的话按一次
 *   Esc 会发出**两次** `cancel` —— 调用方拿到两次「取消」，
 *   在一次取消要触发清理的场景里就是重复执行。
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

/**
 * ⚠⚠ 焦点守卫：这是本组件最容易悄悄坏掉的地方。
 *
 * antd 的 Dialog 在**显示变化**时会主动 focus 自己的内容容器
 * （`.ant-modal`，`tabindex="-1"`，见 `vc-dialog/Dialog.js` 的
 * `onDialogVisibleChanged`）—— 那个时机在进入动画的末尾，**晚于**我们
 * `nextTick` 里的聚焦。于是「焦点在取消上」这条保证会在弹窗出现约 0.2 秒后
 * 被 antd 悄悄拿走。
 *
 * 而这条保证正是这个组件的存在意义：危险操作的默认焦点**必须**在「不删」那一侧，
 * 否则用户习惯性敲回车就会把邮件删掉（文件头已写明）。
 *
 * 所以：只要焦点落在**弹窗容器自身**上，就把它拉回取消按钮。
 * 弹窗里的其它元素（按钮等）不动 —— 用户 Tab 过去的焦点是有效的，不该被抢。
 */
function onFocusIn(event: FocusEvent) {
  const target = event.target as HTMLElement | null
  if (target?.classList.contains('ant-modal'))
    focusCancel()
}

watch(() => props.open, async (open) => {
  if (!open) {
    globalThis.removeEventListener('keydown', onKeydown, true)
    document.removeEventListener('focusin', onFocusIn)
    return
  }

  globalThis.addEventListener('keydown', onKeydown, true)
  document.addEventListener('focusin', onFocusIn)
  // 等 DOM 真的渲染出来再聚焦（`v-if` 之下这一帧按钮还不存在）
  await nextTick()
  focusCancel()
}, { immediate: true })

// 组件被卸载时（例如在回收站里操作后列表重渲染）也要摘掉
onUnmounted(() => {
  globalThis.removeEventListener('keydown', onKeydown, true)
  document.removeEventListener('focusin', onFocusIn)
})
</script>

<template>
  <!--
    ⚠ 用 `v-if` 而不是把 `open` 交给 antd 自己藏：
       `getContainer: false` 之下 antd 的 Dialog 是**常驻 DOM** 的，
       关闭只是给 wrap 加 `display: none`。虽然 `display: none` 的元素本来也
       进不了 Tab 顺序，但我们不依赖那个隐式规则 —— 关闭时整棵子树不存在，
       「看不见的弹窗」这件事在结构上就不可能发生。
  -->
  <a-modal
    v-if="open"
    class="dialog"
    wrap-class-name="overlay"
    :open="true"
    :width="320"
    :footer="null"
    :closable="false"
    :keyboard="false"
    :get-container="false"
    centered
    @cancel="emit('cancel')"
  >
    <template #title>
      <p class="title">
        {{ title }}
      </p>
    </template>

    <p v-if="message" class="message">
      {{ message }}
    </p>

    <div class="actions">
      <!--
        ⚠ 焦点**先给取消按钮**，不是确认按钮。
          危险操作的默认焦点必须在「不删」那一侧 —— 否则用户习惯性敲回车
          就会把邮件删掉。这是「弹窗确认」相对「两步按钮」唯一可能更糟的地方，
          所以在这里补上（antd 会在动画结束时抢焦点，脚本里的 `onFocusIn` 负责拉回来）。
      -->
      <a-button ref="cancelRef" @click="emit('cancel')">
        {{ cancelText }}
      </a-button>
      <a-button type="primary" :danger="danger" @click="emit('confirm')">
        {{ confirmText }}
      </a-button>
    </div>
  </a-modal>
</template>

<style scoped>
/*
 * `.dialog` / `.overlay` 落在 antd 自己的元素上（分别是 `.ant-modal`
 * 与 `.ant-modal-wrap`），所以这里只写**我们额外需要**的那几条；
 * 遮罩的颜色、居中的布局、圆角全部由 antd 负责（见 `shared.css` 的全局收紧）。
 */
.dialog {
  /* 覆盖 antd 的默认宽度上限：弹窗本体宽度由 `:width` 给，这里只保证不撑破小屏 */
  max-width: calc(100vw - 24px);
}

.title {
  margin: 0;
  font-size: 13px;
  font-weight: 600;
  color: var(--mp-text);
}

.message {
  margin: 0;
  font-size: 12px;
  line-height: 1.6;
  color: var(--mp-text-dim);
  /* 长文案（例如带邮件标题）要能换行，不能撑破弹窗 */
  overflow-wrap: anywhere;
}

.actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  margin-top: 16px;
}
</style>
