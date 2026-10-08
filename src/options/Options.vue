<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { useSettings } from '~/logic/bridge'
import { t } from '~/logic/strings'
import AboutPage from './pages/AboutPage.vue'
import AccountsPage from './pages/AccountsPage.vue'
import AiPage from './pages/AiPage.vue'
import BlockedPage from './pages/BlockedPage.vue'
import GeneralPage from './pages/GeneralPage.vue'
import RulesPage from './pages/RulesPage.vue'

/**
 * Options（标签页打开）—— 路由根据 `minimalMode` 切两套
 * （`design/ui-flows.md § 4.1` / `§ 4.1b`）。
 *
 * ⚠ 极简模式下**整个侧边导航都不显示**，而不是「显示但禁用」：
 *   极简模式的产品承诺是「只做一件事」，给用户看到一个灰掉的「提示词」入口
 *   等于在告诉他「你买的版本少了点东西」。隐藏比禁用更符合这个定位。
 *
 * 用自己的一行 `activePage` 而不是引 vue-router：只有 6 个页面、没有深层链接、
 * 没有 history 需求 —— 而 vue-router 会往产物里加 20KB 并且要求 history API
 * （在 `chrome-extension://` 下要额外配 `createWebHashHistory`）。
 */

type PageId = 'general' | 'accounts' | 'rules' | 'ai' | 'blocked' | 'about'

const { app, ai, reload } = useSettings()
const activePage = ref<PageId>('general')

const minimalMode = computed(() => app.value?.minimalMode ?? true)

const NAV: Array<{ id: PageId, key: string }> = [
  { id: 'general', key: 'options.navGeneral' },
  { id: 'accounts', key: 'options.navAccounts' },
  { id: 'rules', key: 'options.navRules' },
  { id: 'ai', key: 'options.navAi' },
  { id: 'blocked', key: 'options.navBlocked' },
  { id: 'about', key: 'options.navAbout' },
]

/** 极简模式只显示「通用」；完整模式显示全部 */
const visibleNav = computed(() => (minimalMode.value ? NAV.slice(0, 1) : NAV))

/**
 * 切到极简模式时把停留在隐藏页面的路由拉回「通用」。
 *
 * 不做这件事的话，用户在「AI 配置」页把模式切到极简 → 导航消失了、但主区还停在
 * AI 配置页上 —— 页面看起来像是「导航栏丢了」。
 */
function ensureVisiblePage() {
  if (!visibleNav.value.some(item => item.id === activePage.value))
    activePage.value = 'general'
}

onMounted(async () => {
  await reload()
  ensureVisiblePage()
})

function select(page: PageId) {
  activePage.value = page
}

/**
 * 模式变化（用户在「通用」页切换）之后立刻校正路由。
 *
 * 用 `watch` 而不是在 render 里算：在 render 期间改 ref 会触发
 * 「组件渲染中修改状态」的警告，而且那一帧已经渲染出错误的组合了。
 */
watch(minimalMode, () => ensureVisiblePage())

defineExpose({ reload })
</script>

<template>
  <div class="options" :class="{ 'is-minimal': minimalMode }">
    <header class="topbar">
      <span class="title">{{ t('options.title') }}</span>
      <span v-if="minimalMode" class="mode-tag">{{ t('app.minimalSuffix') }}</span>
    </header>

    <div class="body">
      <!-- 极简模式：没有侧边导航（ui-flows.md § 4.1b） -->
      <aside v-if="!minimalMode" class="sidebar">
        <button
          v-for="item in visibleNav"
          :key="item.id"
          class="nav-item"
          type="button"
          :class="{ active: activePage === item.id }"
          @click="select(item.id)"
        >
          {{ t(item.key) }}
        </button>
      </aside>

      <main class="content">
        <div v-if="!app" class="loading">
          {{ t('common.loading') }}
        </div>

        <template v-else>
          <GeneralPage v-show="activePage === 'general'" />
          <template v-if="!minimalMode">
            <AccountsPage v-if="activePage === 'accounts'" />
            <RulesPage v-else-if="activePage === 'rules'" />
            <AiPage v-else-if="activePage === 'ai'" :settings="ai" />
            <BlockedPage v-else-if="activePage === 'blocked'" />
            <AboutPage v-else-if="activePage === 'about'" />
          </template>
        </template>
      </main>
    </div>
  </div>
</template>

<style scoped>
.options {
  display: flex;
  flex-direction: column;
  min-height: 100vh;
}

.topbar {
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
  font-size: 11px;
  color: var(--mp-text-faint);
  border: 1px solid var(--mp-border-strong);
  border-radius: 10px;
  padding: 1px 8px;
}

.body {
  flex: 1 1 auto;
  display: flex;
  align-items: stretch;
  min-height: 0;
}

.sidebar {
  flex: 0 0 148px;
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 12px 8px;
  border-right: 1px solid var(--mp-border);
}

.nav-item {
  appearance: none;
  border: 0;
  border-radius: 6px;
  background: transparent;
  color: var(--mp-text-dim);
  font-size: 12px;
  font-family: inherit;
  text-align: left;
  padding: 7px 10px;
  cursor: pointer;
}

.nav-item:hover {
  background: var(--mp-hover);
  color: var(--mp-text);
}

.nav-item.active {
  background: var(--mp-surface-2);
  color: var(--mp-text);
  font-weight: 600;
}

.content {
  flex: 1 1 auto;
  min-width: 0;
  overflow-y: auto;
  padding: 20px 24px 48px;
}

/* 极简模式：内容居中、限宽 —— 一页表单铺满整个屏幕会显得很空 */
.is-minimal .content {
  max-width: 560px;
  margin: 0 auto;
  width: 100%;
}

.loading {
  font-size: 12px;
  color: var(--mp-text-faint);
}
</style>
