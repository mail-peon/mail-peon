<script setup lang="ts">
import type { AppSettings, MailFilterId, MailRetention } from '~/logic/types'
import { computed, onMounted, onUnmounted } from 'vue'
import ConfirmDialog from '~/components/ConfirmDialog.vue'

import { onDataChanged, useAccounts, useMailTypes, useSettings } from '~/logic/bridge'
import { t } from '~/logic/strings'
import {
  MAIL_RETENTION_OPTIONS,
} from '~/logic/types'
import { ERROR_DURATION, useAppMessage } from '~/logic/ui-message'
import AutoCheckField from '../components/general/AutoCheckField.vue'
import GeneralDataCard from '../components/general/GeneralDataCard.vue'
import GeneralModeCard from '../components/general/GeneralModeCard.vue'
import { useGeneralData } from '../composables/useGeneralData'
import { useGeneralSync } from '../composables/useGeneralSync'
import { useSettingsBackup } from '../composables/useSettingsBackup'

/**
 * 通用设置（`design/ui-flows.md § 4.6a` 极简 / `§ 4.6b` 完整）。
 *
 * 两套布局在**同一个组件**里按 `minimalMode` 分支，而不是拆成两个文件：
 * 它们的上半部分（模式切换）完全相同，拆开后「模式切换」这个最关键的控件
 * 会有两份实现 —— 而它正是两套布局之间唯一的通路，重复实现迟早会分叉。
 *
 * 卡片、开关、下拉全部是 Ant Design Vue 的组件（`a-card` / `a-switch` /
 * `a-checkbox` / `a-select` / `a-descriptions`）。
 *
 * ⚠ 操作结果（同步成功/失败、导入导出、清空数据）**不画在页面里**，走全局轻提示
 *   （`logic/ui-message.ts`）。理由与代价都写在那里：颜色必须由「这句话是什么性质」
 *   决定，而页面内的一行文字会把失败跟成功渲染成同一个样子。
 */

const { app, ai, setApp, reload } = useSettings()
const { accounts, syncNow, syncStatus, reload: reloadAccounts } = useAccounts()
const { adapters } = useMailTypes()
const { clearing, usageText, reloadUsage, pending, cancelConfirm, runPending, onClearMails, onClearAll } = useGeneralData({ app, reloadSettings: reload, reloadAccounts })
const { syncing, onSyncNow } = useGeneralSync({ syncNow, syncStatus, reloadUsage, reloadAccounts })
const { importing, onExport, onImportFile } = useSettingsBackup({
  app,
  ai,
  accounts,
  setApp,
  reload: () => Promise.all([reload(), reloadAccounts(), reloadUsage()]),
})
const uiMessage = useAppMessage()

const minimalMode = computed(() => app.value?.minimalMode ?? true)

/**
 * 「默认打开哪个筛选」的下拉选项。
 *
 * Feature 08 起筛选是动态的（状态 + 启用的适配器），所以选项也从适配器列表生成，
 * 不再硬编码四个。`总结` 不作为筛选标签，跳过。
 */
const POPUP_TABS = computed<Array<{ value: MailFilterId, label: string }>>(() => [
  { value: 'important', label: t('popup.tabImportant') },
  { value: 'all', label: t('popup.tabAll') },
  ...adapters.value
    .filter(adapter => adapter.ui !== 'summary')
    .map(adapter => ({ value: `adapter:${adapter.id}` as MailFilterId, label: adapter.name })),
  { value: 'ad', label: t('popup.tabAd') },
])

/**
 * ⚠ 这一页用 `v-show` 挂在 Options 里（见 `Options.vue`），所以它**在打开设置页时
 *   就挂载了**，`onMounted` 那次读账号时用户还没添加任何账号。之后切到「账号」页
 *   新建、再切回来，组件不会重新挂载 —— 没有下面这个订阅，这页会一直显示
 *   「账号 · 0 个」，而「立即同步增量」也会说「没有启用的账号」。
 *
 *   （真机上就是这么表现过一次：账号页有账号、测试连接通过，通用页坚持说没有。）
 */
let stopDataListener: (() => void) | null = null

onMounted(async () => {
  stopDataListener = onDataChanged(() => {
    void reloadAccounts()
    void reloadUsage()
  })
  await reload()
  await Promise.all([reloadAccounts(), reloadUsage()])
})

onUnmounted(() => {
  stopDataListener?.()
  stopDataListener = null
})

function patch(patchValue: Partial<AppSettings>) {
  void setApp(patchValue).then((saved) => {
    if (saved === false)
      uiMessage.error('保存设置失败，请重试', ERROR_DURATION)
    return reloadUsage()
  })
}

/**
 * 模式切换（开关在中间，左边「极简模式」、右边「自定义」）。
 *
 * ⚠ `a-switch` 的语义是「开 = 右侧那项」。所以 checked 是 `!minimalMode`，
 *   而**不是** `minimalMode` —— 写反了会得到一个「往右拨却变成极简」的开关，
 *   而且它看起来完全正常（两种模式都能用，只是与标签相反）。
 */
function onModeToggle(checked: boolean | string | number) {
  patch({ minimalMode: !checked })
}

function onRetentionChange(value: unknown) {
  patch({ mailRetention: value as MailRetention })
}

function onCheckIntervalChange(value: unknown) {
  const minutes = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(minutes))
    return
  patch({ checkIntervalMinutes: Math.round(minutes) })
}
</script>

<template>
  <section class="page">
    <!-- ============ 模式切换（两套布局共用） ============ -->
    <GeneralModeCard :minimal-mode="minimalMode" @toggle="onModeToggle" />

    <!-- ============ 极简模式的通用页 ============ -->
    <template v-if="minimalMode">
      <a-card size="small">
        <AutoCheckField :minutes="app?.checkIntervalMinutes" @change="onCheckIntervalChange" />

        <a-divider class="divider" />

        <a-descriptions :column="1" size="small" class="stats">
          <a-descriptions-item :label="t('general.accountCount', { n: accounts.length })">
            {{ accounts.map(item => item.email).join('、') || '—' }}
          </a-descriptions-item>
          <a-descriptions-item :label="t('general.usage')">
            {{ usageText }}
          </a-descriptions-item>
        </a-descriptions>

        <div class="actions">
          <a-button type="primary" :loading="syncing" :disabled="clearing || importing" @click="onSyncNow">
            {{ syncing ? t('general.syncing') : t('general.syncNow') }}
          </a-button>
          <a-button danger :disabled="syncing || clearing || importing" @click="onClearAll">
            {{ t('general.clearAll') }}
          </a-button>
        </div>
      </a-card>
    </template>

    <!-- ============ 自定义模式的通用页 ============ -->
    <template v-else>
      <a-card size="small" :title="t('general.behavior')">
        <div class="checks">
          <div>
            <a-checkbox
              :checked="app?.excludeAds ?? true"
              @update:checked="(value: boolean) => patch({ excludeAds: value })"
            >
              {{ t('general.excludeAds') }}
            </a-checkbox>
            <p class="mp-hint checkbox-hint">
              {{ t('general.excludeAdsHint') }}
            </p>
          </div>

          <a-checkbox
            :checked="app?.blockedEnabled ?? true"
            @update:checked="(value: boolean) => patch({ blockedEnabled: value })"
          >
            {{ t('general.blockedEnabled') }}
          </a-checkbox>

          <a-checkbox
            :checked="app?.notifyOnNew ?? true"
            @update:checked="(value: boolean) => patch({ notifyOnNew: value })"
          >
            {{ t('general.notifyOnNew') }}
          </a-checkbox>
        </div>

        <a-divider class="divider" />

        <div class="field">
          <span class="field-label">{{ t('general.popupDefaultTab') }}</span>
          <a-select
            class="field-control"
            :value="app?.popupDefaultTab ?? 'important'"
            :options="POPUP_TABS"
            @update:value="(value: unknown) => patch({ popupDefaultTab: value as MailFilterId })"
          />
        </div>

        <a-divider class="divider" />

        <AutoCheckField :minutes="app?.checkIntervalMinutes" @change="onCheckIntervalChange" />
      </a-card>

      <a-card size="small" :title="t('general.retention')">
        <a-radio-group
          class="vertical"
          :value="app?.mailRetention ?? 100"
          @update:value="onRetentionChange"
        >
          <a-radio v-for="option in MAIL_RETENTION_OPTIONS" :key="String(option)" :value="option">
            {{ option === 'unlimited' ? t('general.retentionUnlimited') : `${option} ${t('general.retentionUnit')}` }}
          </a-radio>
        </a-radio-group>

        <a-divider class="divider" />

        <a-descriptions :column="1" size="small" class="stats">
          <a-descriptions-item :label="t('general.usage')">
            {{ usageText }}
          </a-descriptions-item>
        </a-descriptions>

        <div class="actions">
          <a-button type="primary" :loading="syncing" :disabled="clearing || importing" @click="onSyncNow">
            {{ syncing ? t('general.syncing') : t('general.syncNow') }}
          </a-button>
        </div>
      </a-card>

      <GeneralDataCard
        :disabled="syncing || clearing || importing"
        @export="onExport"
        @import="onImportFile"
        @clear="onClearMails"
      />

      <a-card size="small" class="privacy" :title="t('general.privacyTitle')">
        <p class="mp-hint">
          {{ t('general.privacyBody') }}
        </p>
        <div class="actions">
          <a-button danger :disabled="syncing || clearing || importing" @click="onClearAll">
            {{ t('general.clearAll') }}
          </a-button>
        </div>
      </a-card>
    </template>

    <!--
      ⚠ 这里**故意没有**结果提示块。
        操作结果（同步成功/失败/警告、导入导出、清空数据）全部走全局轻提示
        （`logic/ui-message.ts`）—— 画在页面里时，一句「无法连接中继」会和
        「拉取 3 封」共用一个绿色 Alert，而且它会一直占着版面。
    -->

    <!-- 不可撤销动作共用一个确认弹窗（见脚本里 `useConfirmAction` 的说明） -->
    <ConfirmDialog
      :open="pending !== null"
      :title="pending?.title ?? ''"
      :message="pending?.message ?? ''"
      :confirm-text="pending?.confirmText ?? t('common.confirm')"
      danger
      @confirm="runPending"
      @cancel="cancelConfirm"
    />
  </section>
</template>

<style scoped src="../components/general/fields.css" />

<style scoped>
.page {
  display: flex;
  flex-direction: column;
  gap: 12px;
  max-width: 720px;
}

.checks {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

/* 说明文字挂在被说明的那个开关下面，缩进一级 */
.checkbox-hint {
  margin: 2px 0 0 24px;
}

.divider {
  margin: 14px 0;
}

/*
 * 描述列表：antd 默认把标签放进左侧固定宽度的列，窄卡片里正文会被挤成竖条。
 * 这里把标签宽度收到 140px 并让它不换行。
 */
.stats :deep(.ant-descriptions-item-label) {
  width: 140px;
  color: var(--mp-text-dim);
}

.stats :deep(.ant-descriptions-item-content) {
  word-break: break-all;
}

.vertical :deep(.ant-radio-wrapper) {
  display: flex;
  margin-bottom: 6px;
}

.actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-top: 12px;
}

.privacy {
  border-color: color-mix(in srgb, var(--mp-warn) 35%, var(--mp-border));
}
</style>
