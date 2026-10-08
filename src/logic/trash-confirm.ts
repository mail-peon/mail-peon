import type { ComputedRef, Ref } from 'vue'
import type { Mail } from '~/logic/types'
import { computed, ref } from 'vue'
import { t } from '~/logic/strings'

/**
 * 删除确认弹窗的状态与文案。
 *
 * ⚠⚠ **显式标注返回类型，而且是故意的。**
 *
 *   调用方必须**解构**它：
 *
 *   ```ts
 *   // ✅ 对：解构出来是 setup 的顶层绑定，模板会自动解包 ref
 *   const { pending, dialog, ask } = useTrashConfirm(trash)
 *   ```
 *
 *   ```ts
 *   // ❌ 错：Vue 的模板自动解包**不会递归进普通对象**，
 *   //    于是 `tc.pending` 拿到的是 **ref 对象本身**（恒为真值）
 *   //    ⇒ `:open` 永远为真 ⇒ 弹窗一打开就铺满界面；
 *   //    而 `tc.dialog` 也是 ref 对象 ⇒ `.title` 是 undefined
 *   //    ⇒ 它看起来是个**没有内容的空弹窗**。
 *   const tc = useTrashConfirm(trash)
 *   ```
 *
 *   这不是假设 —— 真机上就是这样被发现的（「popup 一打开就自带一个弹窗，没有内容」）。
 *
 *   把返回类型写成具名的 `TrashConfirm` 而不是让 TS 推断一个匿名对象：
 *   文档有了落点，而且将来加字段时调用方那边缺字段会直接报错。
 */
export interface TrashConfirm {
  /** 待确认的邮件；`null` 表示弹窗关闭 */
  pending: Ref<Mail | null>
  /** 弹窗文案（随 `pending` 变化） */
  dialog: ComputedRef<{ title: string, message: string }>
  /** 用户点了删除按钮 —— 先记下来，等确认 */
  ask: (mail: Mail) => void
  /** 用户取消 */
  cancel: () => void
  /** 用户确认 —— 执行真正的删除 */
  confirm: () => Promise<void>
}

/**
 * 「删除邮件」的确认弹窗状态（Popup / Sidepanel 共用）。
 *
 * ## 为什么要抽出来
 *
 * Popup 与 Sidepanel 的删除按钮是同一套交互，而「确认弹窗」需要
 * 三个东西（待确认的邮件、弹窗文案、确认/取消回调）。在两个组件里各写一遍的话，
 * 文案或行为迟早会分叉 —— 而「删除确认」这种地方分叉的后果是
 * **一个界面确认了、另一个没确认**，那是最不该出错的地方。
 *
 * ## 为什么删除要确认（而「标记已读」不用）
 *
 * 删除是**破坏性**的：虽然能恢复，但用户得知道去哪儿恢复。
 * 确认弹窗正是把「去哪儿恢复」这句话说出来的地方 ——
 * 只弹一个「确定吗」而不说后果，等于给用户添一次点击而没有增加任何信息。
 *
 * 反过来「标记已读 / 未读」是可逆且无后果的，弹窗只会让人烦。
 *
 * @param perform 真正执行删除的函数（由调用方给，通常是 `useMails().trash`）
 * @returns 状态与回调 —— **调用方必须解构**，理由见 `TrashConfirm` 的说明
 */
export function useTrashConfirm(perform: (mail: Mail) => Promise<boolean> | void): TrashConfirm {
  const pending = ref<Mail | null>(null)

  const dialog = computed(() => {
    const mail = pending.value
    if (!mail)
      return { title: '', message: '' }

    return {
      title: t('trash.confirmTrashTitle'),
      // 把主题带上：列表里可能有好几封「测试邮件」，只说「这封」用户分不清
      message: t('trash.confirmTrashMessage', { subject: mail.subject || t('common.noSubject') }),
    }
  })

  /** 用户点了删除按钮 —— 先记下来，等确认 */
  function ask(mail: Mail) {
    pending.value = mail
  }

  function cancel() {
    pending.value = null
  }

  async function confirm() {
    const mail = pending.value
    // 先关弹窗再执行：这样即使 `perform` 抛错，界面也不会卡在一个「已确认但没关」的弹窗上
    pending.value = null
    if (mail)
      await perform(mail)
  }

  return { pending, dialog, ask, cancel, confirm }
}
