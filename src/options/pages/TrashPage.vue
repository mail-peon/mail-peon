<script setup lang="ts">
import type { Mail } from '~/logic/types'
import { computed, onUnmounted, ref } from 'vue'
import { formatSender } from '~/adapters/mail/parser'
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
const { mails, loading, restore, deleteForever, empty } = useTrash()

/** 操作结果提示（成功/失败都用同一行，避免布局跳动） */
const notice = ref('')
const busy = ref(false)

/**
 * 「清空回收站」的二次确认状态。
 *
 * ⚠ 用**两步按钮**而不是 `confirm()`。理由：
 *
 *   1. 原生 `confirm()` 是同步阻塞的，而这里在 Options 页里 ——
 *      阻塞会让整个页面卡住（Vue 的更新也排在它后面）；
 *   2. 两步按钮**可以看到自己点的是什么**（按钮文字变成「再点一次」），
 *      而 `confirm()` 弹窗里的「确定」是个没有信息的词；
 *   3. 它有天然的逃生口：不点、或者等一会儿，状态自己复位 ——
 *      不需要「取消」按钮。
 *
 * 这是全项目唯一一个**不可撤销的批量操作**，所以值得比别处更谨慎。
 */
const confirmingEmpty = ref(false)
let confirmTimer: ReturnType<typeof setTimeout> | null = null

/** 复位二次确认状态（离开、超时、或真的执行了） */
function resetConfirm() {
  confirmingEmpty.value = false
  if (confirmTimer) {
    clearTimeout(confirmTimer)
    confirmTimer = null
  }
}

/**
 * 进入「再点一次」状态。
 *
 * ⚠ 6 秒后自动复位：一个一直停在「再点一次」的红色按钮，
 *   用户过一会儿回来点它就会**误删** —— 那时他早忘了自己在确认什么。
 */
function armConfirm() {
  confirmingEmpty.value = true
  if (confirmTimer)
    clearTimeout(confirmTimer)
  confirmTimer = setTimeout(resetConfirm, 6000)
}

onUnmounted(resetConfirm)

const hasMails = computed(() => mails.value.length > 0)

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

async function onRestore(mail: Mail) {
  busy.value = true
  notice.value = ''
  try {
    const ok = await restore(mail)
    notice.value = ok ? t('trash.restoreDone') : '恢复失败'
  }
  finally {
    busy.value = false
  }
}

async function onDeleteForever(mail: Mail) {
  busy.value = true
  notice.value = ''
  try {
    const ok = await deleteForever(mail)
    notice.value = ok ? t('trash.deleteDone') : '删除失败'
  }
  finally {
    busy.value = false
  }
}

/**
 * 清空回收站（两步确认）。
 *
 * ⚠ 确认做在**这里**（UI 层）而不是 `useTrash.empty()` 里：
 *   那是全项目唯一一个不可撤销的批量操作，必须由用户明确点两次。
 *   做进数据层的话任何调用方都会「自动确认」，等于没有确认。
 */
async function onEmpty() {
  if (!hasMails.value) {
    notice.value = t('trash.emptyAlready')
    return
  }

  // 第一次点：只是把按钮切成「再点一次」，什么都不删
  if (!confirmingEmpty.value) {
    notice.value = ''
    armConfirm()
    return
  }

  resetConfirm()
  busy.value = true
  notice.value = ''
  try {
    const count = await empty()
    notice.value = t('trash.emptyDone', { n: count })
  }
  finally {
    busy.value = false
  }
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
        {{ confirmingEmpty ? t('trash.emptyConfirmAgain') : t('trash.emptyAction') }}
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
              <button class="mp-btn mp-btn-danger btn-mini" type="button" :disabled="busy" @click="onDeleteForever(mail)">
                {{ t('trash.deleteForever') }}
              </button>
            </td>
          </tr>
        </tbody>
      </table>
    </div>
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
