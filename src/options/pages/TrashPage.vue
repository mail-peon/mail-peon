<script setup lang="ts">
import type { Mail } from '~/logic/types'
import { computed, ref } from 'vue'
import { formatSender } from '~/adapters/mail/parser'
import ConfirmDialog from '~/components/ConfirmDialog.vue'
import { useSettings, useTrash } from '~/logic/bridge'
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
 */

const { app, setApp } = useSettings()
const { mails, loading, restore, deleteForever, empty, trash } = useTrash()

const hasMails = computed(() => mails.value.length > 0)

/** 操作结果提示（成功/失败都用同一行，避免布局跳动） */
const notice = ref('')
const busy = ref(false)

/**
 * 待确认的动作。
 *
 * ⚠ 三处删除（单条彻底删除、单条移入回收站、清空回收站）**都**要确认，
 *   但它们的文案与后果不同，所以这里存「用户想做什么」而不是一个布尔量 ——
 *   一个 `confirming: boolean` 表达不了「确认哪一条」。
 *
 * ⚠ 弹窗的确认按钮回调里**不能再 await 弹窗**：它是纯 UI，
 *   只回答「点了哪个按钮」。真正的动作在 `runPending()` 里做。
 */
type PendingAction
  = | { kind: 'delete-forever', mail: Mail }
    | { kind: 'trash', mail: Mail }
    | { kind: 'empty' }

const pending = ref<PendingAction | null>(null)

/** 弹窗文案与按钮文案随动作变化 */
const dialog = computed(() => {
  const action = pending.value
  if (!action)
    return { title: '', message: '', confirmText: '' }

  if (action.kind === 'empty') {
    const count = mails.value.length
    return {
      title: t('trash.confirmEmptyTitle'),
      message: t('trash.confirmEmptyMessage', { n: count }),
      confirmText: t('trash.emptyAction'),
    }
  }

  const subject = action.mail.subject || t('common.noSubject')
  if (action.kind === 'delete-forever') {
    return {
      title: t('trash.confirmDeleteTitle'),
      message: t('trash.confirmDeleteMessage', { subject }),
      confirmText: t('trash.deleteForever'),
    }
  }

  return {
    title: t('trash.confirmTrashTitle'),
    message: t('trash.confirmTrashMessage', { subject }),
    confirmText: t('mail.trash'),
  }
})

/** 用户点了确认 —— 执行那个动作 */
async function runPending() {
  const action = pending.value
  pending.value = null
  if (!action)
    return

  busy.value = true
  notice.value = ''
  try {
    if (action.kind === 'empty') {
      notice.value = t('trash.emptyDone', { n: await empty() })
      return
    }

    if (action.kind === 'delete-forever') {
      notice.value = (await deleteForever(action.mail)) ? t('trash.deleteDone') : t('trash.opFailed')
      return
    }

    notice.value = (await trash(action.mail)) ? t('trash.trashDone') : t('trash.opFailed')
  }
  finally {
    busy.value = false
  }
}

function cancelPending() {
  pending.value = null
}

/** 恢复不需要确认：它是**非破坏性**的，而且一键就能撤销 */
async function onRestore(mail: Mail) {
  busy.value = true
  notice.value = ''
  try {
    notice.value = (await restore(mail)) ? t('trash.restoreDone') : t('trash.opFailed')
  }
  finally {
    busy.value = false
  }
}

/** 单条彻底删除 —— 不可撤销，要确认 */
function onDeleteForever(mail: Mail) {
  pending.value = { kind: 'delete-forever', mail }
}

/**
 * 单条移入回收站。
 *
 * ⚠ 回收站页里为什么还有「删除」？因为这一页显示的是**已删除**的邮件，
 *   而用户在这里也可能改主意想让它彻底离开主列表（而不是恢复到列表里）。
 *   它与「彻底删除」的区别正是本页的核心语义，所以两个按钮都要有。
 */
function onTrash(mail: Mail) {
  pending.value = { kind: 'trash', mail }
}

/** 清空回收站 —— 不可撤销的批量操作，要确认 */
function onEmpty() {
  if (!hasMails.value) {
    notice.value = t('trash.emptyAlready')
    return
  }
  pending.value = { kind: 'empty' }
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
    <h2 class="mp-page-title">
      {{ t('trash.title') }}
    </h2>
    <p class="mp-hint intro">
      {{ t('trash.intro') }}
    </p>

    <!-- 自动删除开关：与回收站放同一页，因为它是「邮件为什么会自己到这里」的答案 -->
    <div class="mp-card">
      <label class="mp-checkbox">
        <input
          type="checkbox"
          :checked="app?.autoDeleteExpiredCode ?? true"
          @change="setApp({ autoDeleteExpiredCode: ($event.target as HTMLInputElement).checked })"
        >
        <span>{{ t('trash.autoDelete') }}</span>
      </label>
      <p class="mp-hint indent">
        {{ t('trash.autoDeleteHint') }}
      </p>
    </div>

    <div class="mp-card toolbar">
      <span class="count">
        {{ mails.length }} 封
      </span>
      <span v-if="notice" class="notice">{{ notice }}</span>
      <button
        class="mp-btn mp-btn-danger"
        type="button"
        :disabled="busy || !hasMails"
        @click="onEmpty"
      >
        {{ t('trash.emptyAction') }}
      </button>
    </div>

    <p v-if="loading" class="mp-hint">
      {{ t('trash.loading') }}
    </p>

    <div v-else-if="!hasMails" class="mp-card empty">
      <p class="empty-title">
        {{ t('trash.emptyList') }}
      </p>
      <p class="mp-hint">
        {{ t('trash.emptyListHint') }}
      </p>
    </div>

    <div v-else class="mp-card table-wrap">
      <table class="table">
        <thead>
          <tr>
            <th>{{ t('trash.colFrom') }}</th>
            <th>{{ t('trash.colSubject') }}</th>
            <th class="narrow">
              {{ t('trash.colCode') }}
            </th>
            <th class="narrow">
              {{ t('trash.colTrashedAt') }}
            </th>
            <th class="actions-col">
              {{ t('trash.colActions') }}
            </th>
          </tr>
        </thead>
        <tbody>
          <!--
            ⚠ `v-for` 与 `v-if` **不能写在同一元素上** —— Vue 会警告
            （`vue/no-use-v-if-with-v-for`），而且谁先求值取决于编译顺序。
            包一层 `<template>` 后意图毫无歧义。
          -->
          <tr v-for="mail in mails" :key="mail.id">
            <td class="from" :title="senderOf(mail)">
              {{ senderOf(mail) }}
            </td>
            <td class="subject" :title="mail.subject">
              {{ mail.subject || t('common.noSubject') }}
            </td>
            <td class="narrow">
              <code v-if="mail.code || mail.ai?.code" class="code">{{ mail.code ?? mail.ai?.code }}</code>
              <span v-else class="faint">—</span>
            </td>
            <td class="narrow faint">
              {{ trashedAtOf(mail) }}
            </td>
            <td class="actions-col">
              <button class="mp-btn btn-mini" type="button" :disabled="busy" @click="onRestore(mail)">
                {{ t('trash.restore') }}
              </button>
              <button class="mp-btn btn-mini" type="button" :disabled="busy" @click="onTrash(mail)">
                {{ t('mail.trash') }}
              </button>
              <button class="mp-btn mp-btn-danger btn-mini" type="button" :disabled="busy" @click="onDeleteForever(mail)">
                {{ t('trash.deleteForever') }}
              </button>
            </td>
          </tr>
        </tbody>
      </table>
    </div>

    <!--
      确认弹窗（**三处删除共用**一个实例）。

      ⚠ 用一个实例 + `pending` 状态，而不是每行渲染一个弹窗：
         回收站可能有几百行，每行一个 `v-if` 弹窗会让 DOM 白白多出一个数量级的
         节点（虽然都不显示，但 Vue 仍要为它们建 vnode）。
    -->
    <ConfirmDialog
      :open="pending !== null"
      :title="dialog.title"
      :message="dialog.message"
      :confirm-text="dialog.confirmText"
      danger
      @confirm="runPending"
      @cancel="cancelPending"
    />
  </section>
</template>

<style scoped>
.intro {
  margin-bottom: 12px;
}

.indent {
  margin-left: 22px;
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

.empty {
  text-align: center;
  padding: 24px;
}

.empty-title {
  margin: 0 0 6px;
  font-size: 13px;
  color: var(--mp-text);
}

/*
 * 表格容器：窄窗口下横向滚动而不是挤压列宽。
 * `min-width: 0` 是父级 flex 里的必需项（见弹窗列表那处的说明）。
 */
.table-wrap {
  overflow-x: auto;
  padding: 0;
}

.table {
  width: 100%;
  border-collapse: collapse;
  font-size: 12px;
}

.table th,
.table td {
  text-align: left;
  padding: 8px 10px;
  border-bottom: 1px solid var(--mp-border);
}

.table th {
  font-weight: 600;
  color: var(--mp-text-dim);
  /*
   * 表头吸顶：回收站可能很长，滚动时不知道哪列是什么。
   * `background` 必须给，否则吸顶的表头会透出下面的行。
   */
  position: sticky;
  top: 0;
  background: var(--mp-surface);
}

.table tbody tr:last-child td {
  border-bottom: 0;
}

.table tbody tr:hover {
  background: var(--mp-hover);
}

/* 发件人与主题都可能很长：省略号，完整值放 `title` */
.from,
.subject {
  max-width: 220px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.narrow {
  white-space: nowrap;
}

.actions-col {
  width: 1%;
  white-space: nowrap;
}

.actions-col .btn-mini + .btn-mini {
  margin-left: 6px;
}

.code {
  font-family: var(--mp-font-mono, monospace);
  font-size: 12px;
  letter-spacing: 0.5px;
}

.faint {
  color: var(--mp-text-faint);
}
</style>
