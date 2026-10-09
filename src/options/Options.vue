<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { useSettings } from '~/logic/bridge'
import { readRememberedPage, rememberPage } from '~/logic/options-page-memory'
import { t } from '~/logic/strings'
import AboutPage from './pages/AboutPage.vue'
import AccountsPage from './pages/AccountsPage.vue'
import AiPage from './pages/AiPage.vue'
import BlockedPage from './pages/BlockedPage.vue'
import GeneralPage from './pages/GeneralPage.vue'
import RulesPage from './pages/RulesPage.vue'
import TrashPage from './pages/TrashPage.vue'

/**
 * Options（标签页打开）—— 路由根据 `minimalMode` 切两套
 * （`design/ui-flows.md § 4.1` / `§ 4.1b`）。
 *
 * ⚠ **与设计文档的一处偏差**（文档原写「极简模式只显示『通用』一页」，已改文档）：
 *
 *   极简模式的产品定位是「**功能**只有验证码提取」，但**配置**是它的前提 ——
 *   没有「账号」页就加不了邮箱，没有「AI 配置」就提取不了验证码，
 *   也就是说照原文实现出来的极简模式**根本没法用**。原文只考虑到「少展示功能」，
 *   漏了「配置项 ≠ 功能」这条区分。
 *
 *   所以极简模式保留 **5** 页：通用 / 账号 / AI 配置 / **回收站** / 关于；
 *   只隐藏**属于完整模式功能**的两页：提示词 / 屏蔽列表（以及通用页里的
 *   广告排除、保留数量等开关）。
 *
 *   ⚠ 回收站是后来加的，它**在两种模式下都显示** —— 它不是「功能」而是**数据出口**：
 *     「失效验证码自动删除」默认开着会往回收站里放东西，极简模式藏掉这一页，
 *     用户就找不到那些自动消失的验证码了，而那正是最需要回收站的时候。
 *
 * 用自己的一行 `activePage` 而不是引 vue-router：只有 7 个页面、没有深层链接、
 * 没有 history 需求 —— 而 vue-router 会往产物里加 20KB 并且要求 history API
 * （在 `chrome-extension://` 下要额外配 `createWebHashHistory`）。
 */

type PageId = 'general' | 'accounts' | 'rules' | 'ai' | 'blocked' | 'trash' | 'about'

const { app, ai, reload } = useSettings()

const NAV: Array<{ id: PageId, key: string }> = [
  { id: 'general', key: 'options.navGeneral' },
  { id: 'accounts', key: 'options.navAccounts' },
  { id: 'rules', key: 'options.navRules' },
  { id: 'ai', key: 'options.navAi' },
  { id: 'blocked', key: 'options.navBlocked' },
  { id: 'trash', key: 'options.navTrash' },
  { id: 'about', key: 'options.navAbout' },
]

/**
 * 当前页。初始值来自**前端记忆**（`logic/options-page-memory.ts`）——
 * 刷新后停在上次那一页，而不是每次都弹回「通用」。
 *
 * ⚠ 记忆的取值要经过 `NAV` 的校验（旧版本可能存过一个已删掉的页面），
 *   否则会停在一个没有任何内容的页面上。
 *
 * ⚠ 记忆在**极简模式**下可能指向隐藏页（提示词 / 屏蔽列表）：那时由下面的
 *   `ensureVisiblePage()` 把它拉回「通用」。注意它**不覆盖记忆** ——
 *   记忆只在用户点导航时写（见 `select()`），切回完整模式还能回到提示词页。
 */
const activePage = ref<PageId>(readRememberedPage(NAV.map(item => item.id), 'general'))

const minimalMode = computed(() => app.value?.minimalMode ?? true)

/**
 * 极简模式隐藏的页面：它们对应的是**完整模式的功能**，不是配置前提。
 *
 * ⚠ 「回收站」**不在这里** —— 它在两种模式下都显示。理由：
 *   「失效验证码自动删除」默认开着，而它会把邮件移进回收站；
 *   极简模式下藏掉回收站，用户就找不到那些自动消失的验证码了，
 *   而那正是最需要回收站的时候。
 *   提示词 / 屏蔽列表是**功能**，回收站是**数据出口**，两者不是一类。
 */
const FULL_MODE_ONLY: readonly PageId[] = ['rules', 'blocked'] as const

const visibleNav = computed(() =>
  minimalMode.value ? NAV.filter(item => !FULL_MODE_ONLY.includes(item.id)) : NAV,
)

/**
 * 切到极简模式时把停留在隐藏页面的路由拉回「通用」。
 *
 * 不做这件事的话，用户在「提示词」页把模式切到极简 → 导航里那一项消失了、
 * 但主区还停在提示词页上 —— 页面看起来像是「导航栏丢了」。
 */
function ensureVisiblePage() {
  if (!visibleNav.value.some(item => item.id === activePage.value))
    activePage.value = 'general'
}

onMounted(async () => {
  await reload()
  ensureVisiblePage()
})

/**
 * 切换页面（侧边导航点击）。
 *
 * ⚠ 记忆**只在这里写**：`ensureVisiblePage()` 那种程序性的跳转不该改写它
 *   （否则切一次极简模式就会把「上次在看提示词」抹掉）。理由详见
 *   `logic/options-page-memory.ts` 的文件头。
 */
function select(page: PageId) {
  activePage.value = page
  rememberPage(page)
}

/**
 * 模式变化（用户在「通用」页切换）之后立刻校正路由。
 *
 * 用 `watch` 而不是在 render 里算：在 render 期间改 ref 会触发
 * 「组件渲染中修改状态」的警告，而且那一帧已经渲染出错误的组合了。
 */
watch(minimalMode, () => ensureVisiblePage())

/**
 * 侧边导航的菜单项（antd 的 `Menu` 要的是 `items` 数组，不是一堆子组件）。
 *
 * ⚠ 用 `:items` 而不是 `<a-menu-item v-for>`：`items` 是**数据**，
 *   它让「极简模式少两项」这件事只发生在 `visibleNav` 一处 ——
 *   子组件写法下，`v-for` 与「哪些项被隐藏」会分散到两处。
 */
const navItems = computed(() =>
  visibleNav.value.map(item => ({ key: item.id, label: t(item.key) })),
)

function onNavClick(info: { key: string | number }) {
  select(String(info.key) as PageId)
}

defineExpose({ reload })
</script>

<template>
  <a-layout class="options">
    <header class="topbar">
      <span class="title">{{ t('options.title') }}</span>
      <a-tag v-if="minimalMode" class="mode-tag" :bordered="false">
        {{ t('app.minimalSuffix') }}
      </a-tag>
    </header>

    <a-layout class="body">
      <!--
        侧边导航在两种模式下**都显示**（见文件头：极简模式保留「账号 / AI 配置」等
        配置页，它们是极简模式能用的前提）。两种模式的差别只是 visibleNav 里少了
        「提示词」与「屏蔽列表」。
      -->
      <a-layout-sider class="sidebar" :width="148" theme="light">
        <a-menu
          mode="inline"
          :selected-keys="[activePage]"
          :items="navItems"
          @click="onNavClick"
        />
      </a-layout-sider>

      <a-layout-content class="content">
        <a-spin v-if="!app" class="loading" size="small" />

        <template v-else>
          <GeneralPage v-show="activePage === 'general'" />
          <AccountsPage v-if="activePage === 'accounts'" />
          <AiPage v-else-if="activePage === 'ai'" :settings="ai" />
          <!-- 回收站在两种模式下都显示（见 FULL_MODE_ONLY 的说明） -->
          <TrashPage v-else-if="activePage === 'trash'" />
          <AboutPage v-else-if="activePage === 'about'" />
          <!-- 下面两页只在完整模式出现，与 visibleNav 的过滤保持一致 -->
          <RulesPage v-else-if="activePage === 'rules' && !minimalMode" />
          <BlockedPage v-else-if="activePage === 'blocked' && !minimalMode" />
        </template>
      </a-layout-content>
    </a-layout>
  </a-layout>
</template>

<style scoped>
.options {
  min-height: 100vh;
  /*
   * ⚠ 用 `--mp-surface`（容器色）当整页底色，而不是 `--mp-bg`（页面灰）：
   *   这一页是「一整个应用界面」，顶部栏 + 侧栏 + 内容区都是它的一部分。
   *   弹性布局下 `min-height: 100vh` 保证内容少时也铺满视口。
   */
  background: var(--mp-surface);
}

.topbar {
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 12px 20px;
  border-bottom: 1px solid var(--mp-border);
}

.title {
  font-size: 14px;
  font-weight: 600;
}

.mode-tag {
  margin: 0;
  font-size: 11px;
  line-height: 18px;
}

.body {
  flex: 1 1 auto;
  min-height: 0;
  background: var(--mp-surface);
}

.sidebar {
  border-right: 1px solid var(--mp-border);
  /* 侧栏顶端留一点白，菜单不要贴着顶栏的下边框 */
  padding-top: 8px;
}

.content {
  flex: 1 1 auto;
  min-width: 0;
  overflow-y: auto;
  padding: 20px 24px 48px;
  /* 内容区用页面灰底：卡片（`a-card` 是容器色）落在上面才有层次 */
  background: var(--mp-bg);
}

.loading {
  display: block;
  margin: 32px auto;
}
</style>
