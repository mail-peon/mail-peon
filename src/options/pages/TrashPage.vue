<script setup lang="ts">
import type { Mail } from '~/logic/types'
import { computed, ref } from 'vue'
import { formatSender } from '~/adapters/mail/parser'
import ConfirmDialog from '~/components/ConfirmDialog.vue'
import { useSettings, useTrash } from '~/logic/bridge'
import { useConfirmAction } from '~/logic/confirm-action'
import { formatTimestamp } from '~/logic/notification/format-time'
import { t } from '~/logic/strings'

/**
 * 回收站页。
 *
 * ## 两种「删除」是两件事（产品要求，别搞混）
 *
 * | 操作 | 底层 | 可撤销 |
 * | --- | --- | --- |
 * | 弹窗里点垃圾桶 → 这里出现 | **状态变更**（写 `trashedAt`） | ✅ 能恢复 |
 * | 这里点「彻底删除」/「清空回收站」 | **硬删除**（从 IndexedDB 移除） | ❌ |
 *
 * 刻意**不做**软删除：回收站本身已经是软删除层了，在它下面再叠一层只会让
 * 「彻底删除」名不副实 —— 用户以为空间释放了，其实没有。
 *
 * ## 为什么这一页在极简模式也显示
 *
 * 「失效验证码自动删除」默认开着，而它会把邮件**移进这里**。如果极简模式下
 * 藏掉这一页，用户就找不到那些自动消失的验证码了 —— 那正是最需要回收站的时候。
 * 这与「提示词 / 屏蔽列表」不同：那两页是**完整模式的功能**，这一页是**数据出口**。
 *
 * 列表用 antd 的 `a-table`（原来是一张手写的 `<table>`）：表头吸顶、单元格
 * 溢出省略、横向滚动都是它自带的，不用再维护一套 `.table th/td` 的样式。
 */

const { app, setApp } = useSettings()
const { mails, loading, restore, deleteForever, empty, trash } = useTrash()

const hasMails = computed(() => mails.value.length > 0)

/** 操作结果提示（成功/失败都用同一行，避免布局跳动） */
const notice = ref('')
const busy = ref(false)

/**
 * 表格列定义。
 *
 * ⚠ `width` 只给「窄」的那几列，发件人与主题交给表格自己分配剩余宽度 ——
 *   全给死宽度的话，窄窗口下横向滚动条会一直挂着。
 */
const columns = [
  { title: t('trash.colFrom'), dataIndex: 'from', key: 'from', ellipsis: true },
  { title: t('trash.colSubject'), dataIndex: 'subject', key: 'subject', ellipsis: true },
  { title: t('trash.colCode'), key: 'code', width: 96 },
  { title: t('trash.colTrashedAt'), key: 'trashedAt', width: 140 },
  { title: t('trash.colActions'), key: 'actions', width: 200 },
]

/**
 * 待确认的动作。
 *
 * ⚠ 三处删除（单条彻底删除、单条移入回收站、清空回收站）**都**要确认，
 *   但它们的文案与后果不同，所以 `useConfirmAction` 存的是「用户想做什么」
 *   而不是一个布尔量 —— 一个 `confirming: boolean` 表达不了「确认哪一条」。
 *
 * ⚠ 必须**解构**返回值（理由见 `confirm-action.ts`）。
 */
const { pending, ask: askConfirm, cancel: cancelConfirm, confirm: runPending } = useConfirmAction()

/** 用户点了确认 —— `useConfirmAction` 已经执行了那个动作，这里只负责收尾提示 */
async function withBusy<T>(run: () => Promise<T>, done: (result: T) => string) {
  busy.value = true
  notice.value = ''
  try {
    notice.value = done(await run())
  }
  finally {
    busy.value = false
  }
}

/** 恢复不需要确认：它是**非破坏性**的，而且一键就能撤销 */
async function onRestore(mail: Mail) {
  await withBusy(() => restore(mail), ok => (ok ? t('trash.restoreDone') : t('trash.opFailed')))
}

/** 单条彻底删除 —— 不可撤销，要确认 */
function onDeleteForever(mail: Mail) {
  askConfirm({
    title: t('trash.confirmDeleteTitle'),
    message: t('trash.confirmDeleteMessage', { subject: mail.subject || t('common.noSubject') }),
    confirmText: t('trash.deleteForever'),
    run: () => withBusy(
      () => deleteForever(mail),
      ok => (ok ? t('trash.deleteDone') : t('trash.opFailed')),
    ),
  })
}

/**
 * 单条移入回收站。
 *
 * ⚠ 回收站页里为什么还有「删除」？因为这一页显示的是**已删除**的邮件，
 *   而用户在这里也可能改主意想让它彻底离开主列表（而不是恢复到列表里）。
 *   它与「彻底删除」的区别正是本页的核心语义，所以两个按钮都要有。
 */
function onTrash(mail: Mail) {
  askConfirm({
    title: t('trash.confirmTrashTitle'),
    message: t('trash.confirmTrashMessage', { subject: mail.subject || t('common.noSubject') }),
    confirmText: t('mail.trash'),
    run: () => withBusy(() => trash(mail), ok => (ok ? t('trash.trashDone') : t('trash.opFailed'))),
  })
}

/** 清空回收站 —— 不可撤销的批量操作，要确认 */
function onEmpty() {
  if (!hasMails.value) {
    notice.value = t('trash.emptyAlready')
    return
  }
  const count = mails.value.length
  askConfirm({
    title: t('trash.confirmEmptyTitle'),
    message: t('trash.confirmEmptyMessage', { n: count }),
    confirmText: t('trash.emptyAction'),
    run: () => withBusy(() => empty(), n => t('trash.emptyDone', { n })),
  })
}

/**
 * 邮件在表格里的「发件人」。
 *
 * 用 `formatSender` 而不是自己拼：它与弹窗里的显示保持一致，
 * 而且已经处理了「只有地址没有名字」「名字里有逗号」这些边角。
 */
function senderOf(mail: Mail): string {
  return formatSender(mail.from)
}

/**
 * 删除时间的展示。
 *
 * 复用 `formatTimestamp`：当天给 `HH:mm:ss`、跨天给完整日期。
 * 回收站里的邮件很可能跨天（今天删的、昨天删的混在一起），
 * 所以这个区分在这里比在倒计时里更有价值。
 */
function trashedAtOf(mail: Mail): string {
  return mail.trashedAt ? formatTimestamp(mail.trashedAt) : '—'
}
</script>

<template>
  <section class="page">
    <div class="head">
      <a-typography-title class="title" :level="4">
        {{ t('trash.title') }}
      </a-typography-title>
      <p class="mp-hint intro">
        {{ t('trash.intro') }}
      </p>
    </div>

    <!-- 自动删除开关：与回收站放同一页，因为它是「邮件为什么会自己到这里」的答案 -->
    <a-card size="small">
      <a-checkbox
        :checked="app?.autoDeleteExpiredCode ?? true"
        @update:checked="(value: boolean) => setApp({ autoDeleteExpiredCode: value })"
      >
        {{ t('trash.autoDelete') }}
      </a-checkbox>
      <p class="mp-hint indent">
        {{ t('trash.autoDeleteHint') }}
      </p>
    </a-card>

    <a-card size="small">
      <div class="toolbar">
        <span class="count">{{ mails.length }} 封</span>
        <span v-if="notice" class="notice">{{ notice }}</span>
        <a-button danger :disabled="busy || !hasMails" @click="onEmpty">
          {{ t('trash.emptyAction') }}
        </a-button>
      </div>
    </a-card>

    <!--
      `body-style` 把卡片内边距归零：里面装的是一张**通栏**表格（表格自己管单元格
      内边距），留一圈卡片内边距会让表头与卡片边缘之间空出一条。
      空态与加载态各自带内边距（见 `shared.css` 与 `.loading`），不依赖它。
    -->
    <a-card size="small" :body-style="{ padding: '0' }">
      <a-spin v-if="loading" class="loading" size="small" />

      <a-empty v-else-if="!hasMails">
        <template #description>
          <p class="empty-title">
            {{ t('trash.emptyList') }}
          </p>
          <p class="mp-hint">
            {{ t('trash.emptyListHint') }}
          </p>
        </template>
      </a-empty>

      <a-table
        v-else
        :columns="columns"
        :data-source="mails"
        :pagination="false"
        :scroll="{ x: 720 }"
        row-key="id"
        size="small"
      >
        <template #bodyCell="{ column, record }">
          <template v-if="column.key === 'from'">
            <span :title="senderOf(record)">{{ senderOf(record) }}</span>
          </template>

          <template v-else-if="column.key === 'subject'">
            <span :title="record.subject">{{ record.subject || t('common.noSubject') }}</span>
          </template>

          <template v-else-if="column.key === 'code'">
            <code v-if="record.code || record.ai?.code" class="code">{{ record.code ?? record.ai?.code }}</code>
            <span v-else class="faint">—</span>
          </template>

          <template v-else-if="column.key === 'trashedAt'">
            <span class="faint">{{ trashedAtOf(record) }}</span>
          </template>

          <template v-else-if="column.key === 'actions'">
            <a-space :size="6">
              <a-button size="small" :disabled="busy" @click="onRestore(record)">
                {{ t('trash.restore') }}
              </a-button>
              <a-button size="small" :disabled="busy" @click="onTrash(record)">
                {{ t('mail.trash') }}
              </a-button>
              <a-button size="small" danger :disabled="busy" @click="onDeleteForever(record)">
                {{ t('trash.deleteForever') }}
              </a-button>
            </a-space>
          </template>
        </template>
      </a-table>
    </a-card>

    <!--
      确认弹窗（**三处删除共用**一个实例）。

      ⚠ 用一个实例 + `pending` 状态，而不是每行渲染一个弹窗：
         回收站可能有几百行，每行一个 `v-if` 弹窗会让 DOM 白白多出一个数量级的
         节点（虽然都不显示，但 Vue 仍要为它们建 vnode）。
    -->
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

<style scoped>
.page {
  display: flex;
  flex-direction: column;
  gap: 12px;
  max-width: 900px;
}

.head {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

/* `a-typography-title` 默认带一大截上下外边距，这里只留标题本身的高度 */
.title {
  margin: 0;
  font-size: 16px;
}

.intro {
  margin: 0;
}

.indent {
  margin: 6px 0 0 24px;
}

.toolbar {
  display: flex;
  align-items: center;
  gap: 12px;
}

.count {
  font-size: 12px;
  color: var(--mp-text-dim);
  /*
   * ⚠ `flex: 1` 让计数占满左侧，把按钮推到最右 ——
   *   否则「清空回收站」会紧跟在计数后面，与右对齐的视觉预期不符。
   */
  flex: 1 1 auto;
}

.notice {
  font-size: 12px;
  color: var(--mp-text-dim);
}

.loading {
  display: block;
  margin: 24px auto;
}

.empty-title {
  margin: 0 0 6px;
  font-size: 13px;
  color: var(--mp-text);
}

.code {
  font-family: var(--mp-font-mono);
  font-size: 12px;
  letter-spacing: 0.5px;
}

.faint {
  color: var(--mp-text-faint);
}
</style>
