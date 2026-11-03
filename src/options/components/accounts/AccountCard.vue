<script setup lang="ts">
import type { AccountBusyKind, AccountStatus } from '../../pages/accounts-status'
import type { MailAccount } from '~/logic/types'
import { t } from '~/logic/strings'
import { describeCursor, relativeTime } from '../../account-format'

defineProps<{ account: MailAccount, status?: AccountStatus, busy?: AccountBusyKind }>()
const emit = defineEmits<{ test: [], edit: [], reset: [], delete: [] }>()
</script>

<template>
  <a-card class="account-card" size="small">
    <template #title>
      <div class="account-head">
        <span class="account-label">{{ account.label || account.email }}</span>
        <span class="account-email">{{ account.email }}</span>
        <a-tag :bordered="false">
          {{ account.provider }}
        </a-tag>
      </div>
    </template>

    <!--
        连接状态放在卡片**右上角**（`#extra`），与左边的账号信息两端对齐。
        颜色只有圆点，具体原因在悬停的 tooltip 里 —— 这样「坏消息」不再是一整条
        红色横幅把卡片撑开（那是用户报的「突兀的提示」），但信息一点没少。
      -->
    <template #extra>
      <StatusBadge v-bind="status" />
    </template>

    <div class="account-meta">
      <span>{{ t('accounts.lastSync') }}：{{ relativeTime(account.lastSyncedAt) }}</span>
      <span>同步位置：{{ describeCursor(account.cursor) }}</span>
    </div>

    <a-space class="actions" :size="8" wrap>
      <!--
          ⚠ 每个按钮的 loading 都问「**我这个**操作在不在跑」（`busy === 'test'`），
            而不是问「这个账号忙不忙」—— 后者正是「点重置却让测试连接转圈」那个 bug。
            同一时刻只允许一个操作，所以另一个按钮禁用。
        -->
      <a-button
        size="small"
        :loading="busy === 'test'"
        :disabled="busy === 'reset'"
        @click="emit('test')"
      >
        {{ t('accounts.test') }}
      </a-button>
      <a-button size="small" @click="emit('edit')">
        {{ t('common.edit') }}
      </a-button>
      <a-button
        size="small"
        :loading="busy === 'reset'"
        :disabled="busy === 'test'"
        @click="emit('reset')"
      >
        {{ t('accounts.resetCursor') }}
      </a-button>
      <a-button size="small" danger :disabled="!!busy" @click="emit('delete')">
        {{ t('common.delete') }}
      </a-button>
    </a-space>
  </a-card>
</template>

<style scoped>
.account-head {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 6px;
}

.account-label {
  font-size: 13px;
  font-weight: 600;
}

.account-email {
  font-size: 12px;
  font-weight: 400;
  color: var(--mp-text-dim);
}

.account-meta {
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
  font-size: 11px;
  color: var(--mp-text-faint);
}

/*
 * 卡片右上角的状态徽标。
 *
 * ⚠ 用 `flex: 0 0 auto` 顶住宽度：`#extra` 里的内容默认可以被压缩，
 *   而「同步失败」这种稍长的状态词被压成两行会很难看（卡片头部是单行高度）。
 *   徽标本身的字号 / 配色在 `components/StatusBadge.vue` 里。
 */
.account-card :deep(.ant-card-extra) {
  flex: 0 0 auto;
  margin-inline-start: 8px;
}

.actions {
  margin-top: 4px;
}
</style>
