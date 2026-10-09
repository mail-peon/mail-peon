import type { Ref } from 'vue'
import { ref } from 'vue'

/**
 * 「一个待确认的动作」的状态与回调（设置页里的不可撤销操作用）。
 *
 * ## 它解决什么
 *
 * 设置页里有好几处**不可撤销**的操作：清空邮件列表、清空所有数据、删除账号、
 * 删除提示词规则。它们都需要「先问一句再动手」，而问法（标题 / 正文 / 按钮文案）
 * 各不相同。
 *
 * 早期写法是原生 `window.confirm` + `if (!confirm(...)) return`，同步一行就够：
 *
 * ```ts
 * if (!window.confirm(t('general.confirmClearMails')))
 *   return
 * ```
 *
 * 它的问题是**样式与产品完全脱节**（深色主题下尤其突兀），而且按钮只能叫
 * 「确定 / 取消」，写不出「清空邮件列表」这种把后果讲清楚的按钮文案。
 *
 * 换成弹窗组件之后，流程必然变成两段：点击只**登记**「想做什么」，
 * 真正的动作在弹窗的确认回调里跑。这个模块就是那段登记逻辑 ——
 * 抽出来而不是每个页面写一遍，是因为「确认」这件事最不该在页面之间分叉。
 *
 * ## 为什么不用 antd 的 `Modal.confirm`
 *
 * 那是命令式 API（`Modal.confirm({ onOk })`），而本项目自己的 `ConfirmDialog`
 * 已经处理好了「默认焦点落在取消上」这条关键保证（见该组件文件头）——
 * 命令式 API 拿不到那个焦点行为，一次误敲回车就会删掉数据。
 *
 * ## ⚠ 调用方必须**解构**返回值
 *
 * 与 `useTrashConfirm` 同一条约束：Vue 的模板自动解包**只对 setup 直接暴露的
 * ref 生效**，不会递归进普通对象。写成 `const c = useConfirmAction()` 再用
 * `c.pending` 会拿到 ref 对象本身（恒为真值）⇒ `:open` 永远为真
 * ⇒ 弹窗一打开就铺满界面，而且没有内容。理由详见 `trash-confirm.ts`。
 */
export interface ConfirmAction {
  /** 弹窗标题 */
  title: string
  /** 正文（把后果写在这里） */
  message: string
  /** 确认按钮文案（写成动作本身，例如「清空邮件列表」） */
  confirmText: string
  /** 真正的动作；支持异步，弹窗会在它开始前就关掉 */
  run: () => void | Promise<void>
}

export interface ConfirmActionState {
  /** 待确认的动作；`null` 表示弹窗关闭 */
  pending: Ref<ConfirmAction | null>
  /** 登记一个待确认的动作 */
  ask: (action: ConfirmAction) => void
  /** 用户取消 */
  cancel: () => void
  /** 用户确认 —— 执行那个动作 */
  confirm: () => Promise<void>
}

export function useConfirmAction(): ConfirmActionState {
  const pending = ref<ConfirmAction | null>(null)

  function ask(action: ConfirmAction) {
    pending.value = action
  }

  function cancel() {
    pending.value = null
  }

  async function confirm() {
    const action = pending.value
    // 先关弹窗再执行：这样即使 `run` 抛错，界面也不会卡在一个「已确认但没关」的弹窗上
    pending.value = null
    if (action)
      await action.run()
  }

  return { pending, ask, cancel, confirm }
}
