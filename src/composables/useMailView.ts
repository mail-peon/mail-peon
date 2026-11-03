import type { Ref } from 'vue'
import type { AppSettings, Mail, MailFilterId, MailTypeAdapter } from '~/logic/types'
import { computed, ref, watch } from 'vue'
import { t } from '~/logic/strings'
import { buildMailFilters, filterMails, minimalModeMails, resolveFilterId, sortMails } from '~/popup/list-filter'

/** Shared filtering and default selection for Popup and Sidepanel. */
export function useMailView(mails: Ref<Mail[]>, app: Ref<AppSettings | null>, adapters: Ref<MailTypeAdapter[]>) {
  const activeFilter = ref<MailFilterId>('important')
  const minimalMode = computed(() => app.value?.minimalMode ?? true)
  const excludeAds = computed(() => app.value?.excludeAds ?? true)
  const filters = computed(() => buildMailFilters(mails.value, adapters.value, { excludeAds: excludeAds.value }))
  const visibleMails = computed(() => sortMails(filterMails(mails.value, activeFilter.value, { excludeAds: excludeAds.value })))
  const codeMails = computed(() => minimalModeMails(mails.value))
  const appliedDefault = ref(false)
  watch([app, adapters], () => {
    if (!app.value || appliedDefault.value || !adapters.value.length)
      return
    activeFilter.value = resolveFilterId(filters.value, app.value.popupDefaultTab)
    appliedDefault.value = true
  }, { immediate: true })
  watch(filters, (list) => {
    if (!list.some(filter => filter.id === activeFilter.value))
      activeFilter.value = resolveFilterId(list, 'important')
  })

  function emptyText(filterId: MailFilterId, label: string): string {
    if (filterId === 'important')
      return t('popup.emptyImportant')
    if (filterId === 'all')
      return t('popup.emptyAll')
    if (filterId === 'ad')
      return t('popup.emptyAd')
    return t('popup.emptyAdapter', { name: label })
  }
  return { activeFilter, minimalMode, excludeAds, filters, visibleMails, codeMails, emptyText }
}
