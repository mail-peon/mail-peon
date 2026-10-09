<script setup lang="ts">
import type { Mail } from '~/logic/types'
import { computed, ref } from 'vue'
import { formatSender } from '~/adapters/mail/parser'
import { toastCaption } from '~/logic/notification/copy'
import { t } from '~/logic/strings'
import { isDegraded, mailSummaryLine } from '~/popup/list-filter'
import CodeCountdown from './CodeCountdown.vue'

const props = defineProps<{
  mail: Mail
  /** 极简模式：只显示验证码行，不显示摘要 */
  minimal?: boolean
  /**
   * 这封邮件刚刚被复制过（**纯前端瞬时状态**，不落库）。
   *
   * ⚠ 刻意**不**读 `mail.copyStatus`：那个字段是持久的，语义是
   *   「自动复制流水线处理过这封」（收到验证码时后台帮用户复制了）。
   *   而「刚点了一下复制」是转瞬即逝的界面反馈 ——
   *   两者共用同一个字段会导致它被 `reload()` 覆盖回来，永远清不掉。
   *   详见 `logic/bridge.ts` 的 `justCopied`。
   */
  justCopied?: boolean
}>()

const emit = defineEmits<{
  copy: [mail: Mail]
  read: [mail: Mail, read: boolean]
  dismiss: [mail: Mail]
  open: [mail: Mail]
  /** 移入回收站（用户看到的是「删除」） */
  trash: [mail: Mail]
}>()

const expanded = ref(false)

/**
 * 鼠标是否在卡片里。
 *
 * ⚠ 用 `mouseenter` / `mouseleave` 而不是 CSS `.mail-item:hover`。
 *   这是**真机 bug 的修法**，不是风格偏好：
 *
 *     CSS `:hover` 在**元素内部 DOM 变动后不会重新求值**。
 *     点「复制」时按钮被换成「√ 复制成功」，浏览器不重算悬停状态 ——
 *     于是任何挂在 `.mail-item:hover` 组合上的东西都会跟着复制按钮的行为乱走。
 *     真机现象：「长按复制按钮，删除按钮显示；松开就隐藏」，
 *     而这两个按钮本该毫无关系。
 *
 *   而 `mouseenter` / `mouseleave` 由浏览器在**指针真的进出**时直接触发，
 *   一定会到、也一定会清 —— 与卡片里别处重渲染无关。
 */
const cardHovered = ref(false)

/**
 * 删除按钮的热区是否可见。
 *
 * ⚠ 由两个来源共同决定，**缺一不可**：
 *
 *   1. `cardHovered` —— 鼠标在卡片里就露出图标（用户要的体验）；
 *   2. `trashZoneHovered` —— 鼠标在热区里时**一定**可见。
 *
 *   第 2 条不能省：热区在卡片内部，指针从卡片移到热区**不会**触发卡片的
 *   `mouseleave`（两者是嵌套关系），但如果哪天结构调整了，
 *   有这一条就能保证「鼠标明明在图标上，图标却不见了」不会发生。
 *
 * ⚠ 热区**始终** `pointer-events: auto`（不随可见性切换）。
 *   早期版本在隐藏时设 `pointer-events: none`，看似更安全
 *   （防止看不见的按钮吃掉点击），但它有个致命副作用：
 *   **隐藏的元素收不到 `mouseenter`，于是永远没法把自己点亮**。
 *   卡片的 `mouseenter` 负责第一次点亮，之后热区必须一直能接收事件。
 *   至于「点右上角不该误触删除」—— 不需要靠 `pointer-events` 挡：
 *   热区的 `mouseenter` 一旦触发，图标就可见了，用户看得见自己在点删除。
 */
const trashZoneHovered = ref(false)

const trashZoneVisible = computed(() => cardHovered.value || trashZoneHovered.value)

function onCardEnter() {
  cardHovered.value = true
}

function onCardLeave() {
  cardHovered.value = false
  /*
   * ⚠ 一起复位：`mouseenter` / `mouseleave` 不冒泡，
   *   但指针离开卡片时热区的 `mouseleave` **可能**因为 DOM 变动而没派发到。
   *   这里兜一下 —— 否则会留下一个「鼠标早走了、图标还亮着」的状态。
   */
  trashZoneHovered.value = false
}

const sender = computed(() => formatSender(props.mail.from))
const senderTitle = computed(() => toastCaption(props.mail.from))
const subject = computed(() => props.mail.subject.trim() || t('common.noSubject'))
const code = computed(() => props.mail.code ?? props.mail.ai?.code ?? null)
const degraded = computed(() => isDegraded(props.mail.ai))
const pending = computed(() => props.mail.processing === 'pending' && !props.mail.ai)
const isAd = computed(() => props.mail.ai?.isAd === true)

/** 相对时间（「5 分钟前」）。不引 dayjs：只有一个函数需要，多一个依赖不划算 */
const relativeTime = computed(() => formatRelative(props.mail.receivedAt))

function formatRelative(ts: number): string {
  const diff = Date.now() - ts
  if (diff < 60_000)
    return t('common.justNow')
  if (diff < 3_600_000)
    return t('common.minutesAgo', { n: Math.floor(diff / 60_000) })
  if (diff < 86_400_000)
    return t('common.hoursAgo', { n: Math.floor(diff / 3_600_000) })
  if (diff < 7 * 86_400_000)
    return t('common.daysAgo', { n: Math.floor(diff / 86_400_000) })
  // 超过一周就直接给日期：`12 天前` 不如 `3月14日` 有用
  return new Date(ts).toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' })
}

const urgencyClass = computed(() => {
  if (code.value)
    return 'flag-code'
  if (props.mail.ai?.urgency === 'high')
    return 'flag-high'
  return ''
})
</script>

<template>
  <article
    class="mail-item"
    :class="[{ 'is-ad': isAd, 'is-read': mail.read }, urgencyClass]"
    @click="emit('open', mail)"
    @mouseenter="onCardEnter"
    @mouseleave="onCardLeave"
  >
    <header class="head">
      <span class="sender" :title="senderTitle">{{ sender }}</span>
      <!--
        时间。它与右上角的垃圾桶**互斥** —— 垃圾桶出现时它让位。
        两者视觉上占**同一个位置**（时间在文档流，垃圾桶绝对定位盖在它上面），
        不互斥的话会糊在一起。

        ⚠ 用 `:class` 绑定**同一个** `trashZoneVisible`，**不**用 CSS 兄弟选择器
          （`.trash-zone.is-visible ~ .time-slot .time` 那种）。
          那种写法把「时间该不该显示」寄托在「另一个元素的 class + DOM 顺序 +
          scoped 属性」三件事同时成立上 —— 任何一环不对就**静默失效**
          （CSS 选择器匹配失败不会报错，界面只是没变）。

          而这个组件里**所有**显隐都由 class 状态驱动（垃圾桶、复制成功都是），
          保持一致：状态是唯一真相，选择器不再参与判断。

        ⚠ 用**透明度**而不是 `v-if`：后者会让头部这一行的宽度跳变，
          flex 布局下发件人名字会被挤得抖一下。
      -->
      <span class="time-slot" :class="{ 'is-hidden': trashZoneVisible }">
        <time class="time">{{ relativeTime }}</time>
      </span>

      <!--
        ⚠⚠ 删除按钮的显示**完全由它自己的鼠标事件驱动**，不依赖任何
           CSS `:hover` 组合（`.mail-item:hover …` 那种）。

           为什么：CSS `:hover` 在**卡片内部 DOM 变动后不会重算**。
           点「复制」时按钮被换成「√ 复制成功」，浏览器不重新求值悬停状态 ——
           于是挂在这个组合上的删除按钮会跟着复制按钮的行为乱走
           （真机现象：「长按复制按钮，删除按钮显示；松开就隐藏」）。
           根因就是两个本该无关的按钮被**一条 CSS 条件**绑在了一起。

           现在：`mouseenter` / `mouseleave` 由浏览器在指针真的进出时直接触发，
           一定会到、也一定会清 —— 与卡片里别的地方重渲染无关。

        ⚠ 按钮要 `@click.stop`：整张卡片绑了「打开邮件」，
          不拦住冒泡的话点删除会顺手把邮件打开（那是用户最不想要的结果）。
      -->
      <span
        class="trash-zone"
        :class="{ 'is-visible': trashZoneVisible }"
        @mouseenter="trashZoneHovered = true"
        @mouseleave="trashZoneHovered = false"
      >
        <a-button
          class="trash"
          type="text"
          size="small"
          :title="t('mail.trash')"
          :aria-label="t('mail.trash')"
          @click.stop="emit('trash', mail)"
        >
          <span class="i-pixelarticons-trash" aria-hidden="true" />
        </a-button>
      </span>
    </header>

    <p class="subject">
      {{ subject }}
    </p>

    <!-- 极简模式只需要验证码那一行 -->
    <div v-if="code" class="code-row">
      <span class="code-label">{{ t('mail.code') }}</span>
      <code class="code">{{ code }}</code>
      <!--
        「复制」是一个**文字按钮**，不是按钮样式的方块 ——
        它读起来是这句话的一部分（「验证码 34949 复制」），
        而不是一个需要去找的控件。antd 的 `type="link"` 正是这个语义
        （无边框、无底色、主色文字）。

        ⚠ 判据是 `justCopied`（**前端瞬时状态**），不是 `mail.copyStatus`。
          后者是持久字段，读完就写库、`reload()` 又会把它读回来，
          于是「√ 复制成功」永远变不回「复制」。

        ⚠ 点完之后变成绿色的「√ 复制成功」，几秒后自动变回「复制」
          （定时器在 `useMails().markJustCopied` 里）。
          复原是必需的：用户可能有**两个**验证码要复制，
          第一封永远停在成功态会让他分不清哪封是刚点过的。
      -->
      <a-button
        v-if="!justCopied"
        class="copy"
        type="link"
        size="small"
        @click.stop="emit('copy', mail)"
      >
        {{ t('mail.copy') }}
      </a-button>
      <span v-else class="copy-done">{{ t('mail.copyDone') }}</span>
    </div>

    <template v-else-if="!minimal">
      <p v-if="pending" class="summary pending">
        {{ t('mail.pending') }}
      </p>
      <p v-else class="summary">
        {{ mailSummaryLine(mail) }}
      </p>
    </template>

    <p v-if="degraded" class="degraded" :title="mail.ai?.error ?? t('mail.degradedTip')">
      <a-tag color="warning">
        {{ t('mail.degraded') }}
      </a-tag>
    </p>

    <!-- 展开态：摘要全文 + 操作 -->
    <div v-if="expanded && !minimal" class="detail" @click.stop>
      <p class="detail-label">
        {{ t('mail.summary') }}
      </p>
      <pre class="detail-body">{{ mail.ai?.summary || t('mail.minimalCaptured') }}</pre>
      <div class="actions">
        <a-button size="small" @click="emit('read', mail, !mail.read)">
          {{ mail.read ? t('mail.markUnread') : t('mail.markRead') }}
        </a-button>
        <a-button size="small" @click="emit('dismiss', mail)">
          {{ t('mail.dismiss') }}
        </a-button>
      </div>
    </div>

    <a-button
      v-if="!minimal && !code"
      class="expand"
      type="link"
      size="small"
      :aria-expanded="expanded"
      @click.stop="expanded = !expanded"
    >
      {{ expanded ? t('common.collapse') : t('common.expand') }}
    </a-button>

    <!--
      倒计时：**只在邮件里明确写了有效期**时出现，且必须在 card 的**最后一个**
      子元素上 —— 它靠负外边距贴到卡片底部（见 `CodeCountdown` 的样式说明），
      放在中间会把它上面的内容一起「拉」到底部。

      `mail.codeExpiresAt` 没值就不渲染（不要给默认时长）。
      ⚠ 两个字段必须**同时**存在：`codeValidForSeconds` 是进度条的分母，
        缺了它进度条只能瞎猜（就是「每次打开都从 100% 开始」那个 bug）。
        数据层保证它们同生同灭（见 `deriveCodeExpiry`），这里再兜一道。
    -->
    <CodeCountdown
      v-if="code && mail.codeExpiresAt && mail.codeValidForSeconds"
      :expires-at="mail.codeExpiresAt"
      :valid-for-seconds="mail.codeValidForSeconds"
    />
  </article>
</template>

<style scoped>
.mail-item {
  position: relative;
  padding: 10px 12px;
  border: 1px solid var(--mp-border);
  border-radius: 10px;
  background: var(--mp-surface);
  cursor: pointer;
  transition: border-color 0.15s, background 0.15s;
  /*
   * ⚠ `flex: 0 0 auto` —— **不能删**。
   *
   *   卡片被放在一个 `display: flex; flex-direction: column; overflow-y: auto`
   *   的列表里（`Popup.vue` / `Sidepanel.vue` 的 `.list`）。
   *   而 flex 子项的默认值是 `flex-shrink: 1` —— 于是**邮件一多，所有卡片会被
   *   按比例压扁**：容器高度固定（弹窗 `height: 480px`），子项总高超出时
   *   浏览器优先压缩子项，而不是让容器滚动。
   *
   *   症状很有迷惑性：邮件少的时候完全正常，一多就「内容显示不全」，
   *   看起来像文本被截断（其实是被压缩后 `overflow: hidden` 裁掉了）。
   *
   *   `0 0 auto` = 不放大、**不缩小**、高度用内容自己算 —— 这样超出部分
   *   才会交给容器的 `overflow-y: auto` 去滚动。
   */
  flex: 0 0 auto;
  /*
   * ⚠ `overflow: hidden` 是**必需**的，不是修饰。
   *
   *   倒计时进度条是矩形（`CodeCountdown` 用负外边距贴到卡片底部），
   *   而卡片有 `border-radius: 10px` —— 不加这行的话，进度条的直角会**盖住**
   *   卡片底部的圆角，看起来像「圆角被啃掉了」。
   *
   *   `overflow: hidden` 让所有子元素都被卡片的圆角裁剪，这也是给圆角容器
   *   放全宽子元素的**标准做法**（比给每个子元素单独加圆角更省、更不容易漏）。
   *
   *   这条本身不产生滚动问题：配合上面的 `flex: 0 0 auto`，卡片高度由内容决定、
   *   不会溢出，所以 `hidden` 不会裁掉任何东西。
   */
  overflow: hidden;
}

.mail-item:hover {
  border-color: var(--mp-border-strong);
  /* 悬停时给一点极淡的底色：antd 的卡片交互就是这个手感（hoverable） */
  background: var(--mp-surface-2);
}

/* 广告：视觉弱化（features/04 § 5：透明度 0.6 / 灰边） */
.mail-item.is-ad {
  opacity: 0.6;
}

.mail-item.is-read .subject {
  font-weight: 500;
  color: var(--mp-text-dim);
}

/*
 * 紧急度用 **border-top** 的一条 2px 色条表达，不再用 border-left。
 *
 * ⚠ 改掉左侧色条的直接原因：它与倒计时进度条**抢同一条视觉轴线** ——
 *   左边竖着一条绿线、下面横着一条进度条，两个装饰条同时出现显得很乱，
 *   而且左侧色条在极简模式（只有验证码）里几乎没有信息量：
 *   那一屏**全是**验证码邮件，每一张卡都绿，等于没标。
 *
 *   这里只保留 `flag-high`（真正的紧急度信号），并且换到顶部。
 *
 * 注意 `urgencyClass` 的逻辑是「有验证码 → `flag-code`，否则才看 urgency」，
 * 所以验证码邮件**不会**拿到这道红条 —— 两类标记不会同时出现。
 */
.mail-item.flag-high {
  border-top: 2px solid color-mix(in srgb, var(--mp-danger) 70%, transparent);
}

.head {
  display: flex;
  /*
   * ⚠ `baseline` 而不是 `center`：发件人与时间都是文字，按基线对齐才齐。
   *   给 `.time-slot` 加 `align-self: center` 让**它**在这个基线行里居中 ——
   *   否则那个 18px 高的盒子会把基线往下推，发件人名字会跟着偏下。
   */
  align-items: baseline;
  gap: 8px;
}

.sender {
  flex: 1 1 auto;
  min-width: 0;
  font-size: 12px;
  color: var(--mp-text-dim);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

/*
 * 时间的容器（只有时间在正常流里）。
 *
 * ⚠ 垃圾桶按钮**不**相对这里定位 —— 它相对 `.mail-item` 定位到卡片右上角。
 *   写在这里只是为了跟着头部这一行排版。
 *
 * ⚠ 定位与尺寸写在**这里**而不是用 UnoCSS 工具类：
 *   这个文件是 scoped SFC，`.time-slot` 会编译成 `.time-slot[data-v-xxx]`
 *   （特异度 0,2,0），而 UnoCSS 的 `.absolute` 是 0,1,0 —— scoped 一定赢。
 *   混着写会变成「工具类看着生效了其实被覆盖」，那种问题极难察觉。
 *   所以：**布局在 scoped，图标本身用 UnoCSS**（`i-pixelarticons-trash`）。
 */
.time-slot {
  flex: 0 0 auto;
  display: inline-flex;
  align-items: center;
  /*
   * ⚠ `center` 覆盖父级的 `baseline`：见 `.head` 的说明 ——
   *   固定高度的盒子按基线对齐会把整行的基线往下推。
   */
  align-self: center;
  height: 14px;
}

.time {
  font-size: 11px;
  color: var(--mp-text-faint);
  transition: opacity 0.12s;
}

/*
 * 垃圾桶的**悬停热区**（卡片右上角那一小块）。
 *
 * ⚠ 这个元素存在的唯一理由是**独立的悬停状态**。
 *   直接让 `.trash` 看 `.mail-item:hover` 会遇到「悬停状态卡死」——
 *   卡片内部一重渲染（例如点了复制），浏览器不重算悬停，
 *   于是鼠标移走了垃圾桶还挂着。热区自己的 `:hover` 由鼠标位置直接决定，
 *   不受卡片重渲染影响。
 *
 * ⚠ `position: absolute` 相对 `.mail-item`（那里有 `position: relative`），
 *   `top` / `right` 因此从**卡片边缘**算起 —— 这正是「在右上角」的意思。
 *   早期版本把它放在 `.time-slot` 里（那个容器当时有 `position: relative`），
 *   于是它落在「时间的上方」（卡片中部），是用户报过的 bug。
 *
 * ⚠ 热区比图标大一圈（18×18），否则「瞄准它」这一步很难命中。
 *   `top: 7px` = 图标偏移 8px 再往外留 1px 的余量。
 */
.trash-zone {
  position: absolute;
  /*
   * ⚠ `top` / `right` 是**按卡片的 `padding: 10px 12px` 反算出来的**，
   *   不是随手填的数。目标是让垃圾桶与时间**切换时右边缘不动**：
   *
   *   时间（`.time`）在文档流里，它的右边缘距卡片内边距 = `12px`
   *   （正好是卡片的 `padding-right`）。
   *   垃圾桶是绝对定位的，要让**它的右边缘**落在同一条线上：
   *
   *     right = padding-right = 12px
   *
   *   ⚠ 不要试图去「让图标中心对齐文字右边缘」—— 那是另一种对齐
   *     （`right = 12 - 18/2 = 3px`），效果是图标整体**往里缩**，
   *     看起来像被挤到中间去了。用户要的是「右侧位置在文字右侧」：
   *     两个东西的**右边缘**在同一条竖线上，切换时右边不会跳。
   *
   * ⚠ 竖向同理：时间行高 14px、`align-self: center`，
   *   热区 18px 居中后 `top = 10 - (18 - 14) / 2 = 8px`。
   *
   * ⚠ 这三个数（卡片 padding、热区尺寸、这两个偏移）**必须一起改**。
   *   内边距变了而这里不动，切换时右边缘就会错开 ——
   *   `mail-item-style.spec.ts` 里有断言同时读它们并检查这个关系。
   */
  top: 8px;
  right: 12px;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 18px;
  height: 18px;
  /*
   * ⚠ 始终 `pointer-events: auto`，**不随可见性切换**。
   *
   *   早期版本在隐藏时设 `pointer-events: none`（想防止看不见的按钮吃掉点击），
   *   但那有个致命副作用：**隐藏的元素收不到 `mouseenter`，永远没法把自己点亮**。
   *   卡片的 `mouseenter` 负责第一次点亮，之后热区必须一直能接收事件。
   *
   *   至于「点右上角不该误触删除」—— 不需要靠 `pointer-events` 挡：
   *   热区的 `mouseenter` 一旦触发图标就可见了，用户看得见自己在点删除。
   */
  opacity: 0;
  transition: opacity 0.12s;
}

/*
 * 垃圾桶热区的显示规则。
 *
 * ⚠ 显示由 **`.is-visible` 类**决定，而那个类是脚本里算出来的
 *   `cardHovered || trashZoneHovered`（见脚本里的说明）。
 *
 *   为什么不用 CSS `:hover` 组合（`.mail-item:hover .trash-zone` 那种）：
 *   **卡片内部一重渲染，浏览器就不重算 `:hover`**。点「复制」时按钮被换成
 *   「√ 复制成功」，于是挂在卡片级 `:hover` 上的东西会跟着复制按钮乱走 ——
 *   真机现象就是「长按复制按钮，删除按钮显示；松开就隐藏」。
 *   两个本该无关的按钮被一条 CSS 条件绑在了一起。
 *
 *   而 `mouseenter` / `mouseleave` 由浏览器在**指针真的进出**时直接触发，
 *   一定会到、也一定会清 —— 与卡片里别处重渲染无关。
 *
 * ⚠ `:focus-within` 那一半保留（用 CSS）：键盘用户 Tab 进来时必须能看到按钮，
 *   否则 `opacity: 0` 之下他根本发现不了这个功能。
 *   这条不受「重渲染不重算」影响 —— 焦点变化一定会触发重算。
 */
.trash-zone.is-visible,
.mail-item:focus-within .trash-zone {
  opacity: 1;
}

/*
 * 时间让位（垃圾桶出现时）。
 *
 * ⚠ 判据是 `.time-slot.is-hidden`，由 `:class` 绑的 `trashZoneVisible` 打开 ——
 *   与垃圾桶用的是**同一个状态值**，所以不可能出现「一个显示了、另一个还没反应」。
 *
 * ⚠ 早期写法是兄弟选择器 `.trash-zone.is-visible ~ .time-slot .time`，
 *   看着等价，实际不生效（而 CSS 匹配失败**不会报错**，界面只是没变）。
 *   教训：显隐判断交给状态，别交给选择器 —— 选择器错了是静默的。
 */
.time-slot.is-hidden .time {
  opacity: 0;
}

/*
 * 垃圾桶本体（antd 的 `type="text"` 按钮）。
 *
 * ⚠ `position: absolute; inset: 0` —— 填满热区。
 *   不再自己算 `top` / `right`（那会让「热区」与「图标」两处偏移各写一遍，
 *   改一个忘一个就错位）。
 *
 * ⚠ `width/height: auto` 是**为了压过 antd**：`.ant-btn` 自己带
 *   `height: <controlHeight>`（30px），有显式高度时 `inset: 0` 的「上下拉伸」
 *   就不生效了，图标会从 18px 的热区里溢出来。只有把它交还给 auto，
 *   `top/right/bottom/left: 0` 才能把按钮撑成热区那么大。
 */
.trash {
  position: absolute;
  inset: 0;
  width: auto;
  height: auto;
  min-width: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 0;
  border: 0;
  background: transparent;
  /* 先灰后红：这一层是「出现在卡片右上角的默认色」 */
  color: var(--mp-text-faint);
  font-size: 14px;
  line-height: 1;
  cursor: pointer;
  transition: color 0.12s;
}

/*
 * ⚠ 只有图标，没有文字 ⇒ 把 `shared.css` 给「图标 + 文字」留的右边距归零，
 *   否则 18px 的热区里图标会偏左 3px。
 */
.trash [class^='i-'] {
  margin-inline-end: 0;
}

/*
 * 鼠标移到**垃圾桶本身**上才变红。
 *
 * ⚠ 红色是「危险动作」的信号，只在用户真的瞄准它时给 ——
 *   一出现就红会让整个列表显得很吵，而且失去强调作用。
 */
.trash:hover {
  color: var(--mp-danger);
  /* antd 的文字按钮有自己的 hover 底色，这里统一不要 —— 它只是个小图标 */
  background: transparent;
}

/*
 * 键盘可达性：Tab 到按钮时必须能看见它。
 *
 * ⚠ 这里**不给焦点框**（早期版本画了一圈 `outline`，用户反馈「按下后有边框」，
 *   看起来像按钮自带边框）。改用「图标本身变红 + 可见」当焦点指示。
 *
 * ⚠ 但不能什么都不给：`.trash-zone` 默认 `opacity: 0`，
 *   而只用键盘的用户从没悬停过卡片 ⇒ 按钮完全不可见。
 *   `.mail-item:focus-within` 那一半负责这件事（上面已写）。
 */
.trash:focus,
.trash:focus-visible {
  outline: none;
}

.trash:focus-visible {
  color: var(--mp-danger);
}

.subject {
  margin: 3px 0 0;
  font-size: 13px;
  font-weight: 600;
  line-height: 1.4;
  overflow: hidden;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
}

.summary {
  margin: 4px 0 0;
  font-size: 12px;
  line-height: 1.5;
  color: var(--mp-text-dim);
  overflow: hidden;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
}

.summary.pending {
  font-style: italic;
  color: var(--mp-text-faint);
}

.code-row {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 6px;
}

.code-label {
  font-size: 12px;
  color: var(--mp-text-dim);
}

.code {
  font-family: var(--mp-font-mono);
  font-size: 15px;
  font-weight: 600;
  letter-spacing: 0.5px;
  color: var(--mp-text);
}

/*
 * 「复制」是**文字按钮**：没有边框、没有底色，读起来是验证码那一行的延续
 * （「验证码 34949 复制」）。做成方块按钮会让它看起来像另一个控件，
 * 而它其实只是对左边那个验证码的一个动作。
 *
 * ⚠ 用 `--mp-accent` 而不是继承正文色：它是个可点的动作，需要一点视觉提示；
 *   但只在文字色上体现（不加下划线/底色），保持轻量。
 *
 * ⚠ `height: auto` + `padding: 0`：antd 的按钮默认是 30px 高的盒子，
 *   直接放进这一行会把行高撑起来（验证码那一行看起来「中间空了一块」）。
 *   把它压回纯文字的高度，只在字色上有区别。
 */
.copy {
  appearance: none;
  border: 0;
  background: transparent;
  height: auto;
  padding: 0;
  color: var(--mp-accent);
  font-family: inherit;
  font-size: 11px;
  line-height: inherit;
  cursor: pointer;
  transition: color 0.12s;
}

.copy:hover {
  text-decoration: underline;
  /* antd 的文字按钮 hover 会换色，这里保持一致（不引第二个主色） */
  color: var(--mp-accent);
  background: transparent;
}

/*
 * 复制成功：绿色。
 *
 * ⚠ 与 `.copy` 用**同一套字号 / 行高 / 外边距** —— 两者互斥地出现在同一个位置，
 *   盒模型差一点就会让那一行轻微跳动，看起来像整个列表抖了一下。
 */
.copy-done {
  font-size: 11px;
  font-weight: 600;
  color: var(--mp-success);
}

.degraded {
  margin: 6px 0 0;
}

/* antd 的 `Tag` 自带内边距，这里只把它压小一点（卡片很窄） */
.degraded :deep(.ant-tag) {
  margin: 0;
  font-size: 11px;
  line-height: 16px;
  padding: 0 6px;
}

.detail {
  margin-top: 8px;
  padding-top: 8px;
  border-top: 1px dashed var(--mp-border);
}

.detail-label {
  margin: 0 0 4px;
  font-size: 11px;
  color: var(--mp-text-faint);
}

.detail-body {
  margin: 0;
  font-family: inherit;
  font-size: 12px;
  line-height: 1.6;
  white-space: pre-wrap;
  word-break: break-word;
  color: var(--mp-text);
  max-height: 220px;
  overflow: auto;
}

.actions {
  display: flex;
  gap: 6px;
  margin-top: 8px;
}

/*
 * 「展开 / 收起」也是文字按钮 —— 与「复制」同理：它是这段文字的延续，
 * 不该长成一个方块按钮跟下面的操作按钮混在一起。
 */
.expand {
  height: auto;
  margin-top: 4px;
  padding: 0;
  color: var(--mp-text-faint);
  font-size: 11px;
  line-height: inherit;
}

.expand:hover {
  color: var(--mp-text-dim);
  background: transparent;
}
</style>
