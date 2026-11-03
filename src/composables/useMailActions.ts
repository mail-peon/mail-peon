import type { ConfirmMatch, Mail } from '~/logic/types'
import { parseSafeHttpUrl } from '~/logic/mail-types/url'
import { t } from '~/logic/strings'
import { useTrashConfirm } from '~/logic/trash-confirm'
import { ERROR_DURATION, useAppMessage } from '~/logic/ui-message'

/** The two mail views share confirmation actions while keeping their own read policy. */
export function useMailActions(options: {
  trash: (mail: Mail) => Promise<boolean>
  setRead: (mail: Mail, read: boolean) => Promise<void>
  openUrl: (url: string) => Promise<unknown>
}) {
  const uiMessage = useAppMessage()
  const { pending: trashPending, dialog: trashDialog, ask: askTrashConfirm, cancel: cancelTrashConfirm, confirm } = useTrashConfirm(options.trash)

  async function onConfirmTrash() {
    if (!await confirm())
      uiMessage.error(t('mail.trashFailed'), ERROR_DURATION)
  }

  async function onConfirm(mail: Mail, match: ConfirmMatch) {
    const url = parseSafeHttpUrl(match.url)
    if (!url) {
      uiMessage.error(t('mail.confirmInvalid'), ERROR_DURATION)
      return
    }
    try {
      await options.openUrl(url.toString())
      if (!mail.read)
        await options.setRead(mail, true)
    }
    catch (error) {
      console.warn('[mail-peon] 打开确认链接失败', error)
      uiMessage.error(t('mail.confirmFailed'), ERROR_DURATION)
    }
  }
  return { trashPending, trashDialog, askTrashConfirm, cancelTrashConfirm, onConfirmTrash, onConfirm }
}
