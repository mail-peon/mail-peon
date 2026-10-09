import type { Component } from 'vue'
import AntApp from 'ant-design-vue/es/app'
import ConfigProvider from 'ant-design-vue/es/config-provider'
import zhCN from 'ant-design-vue/es/locale/zh_CN'
import { createApp, h } from 'vue'
import { usePeonTheme } from '~/styles/theme'
import { setupApp } from './common-setup'

/**
 * 三个界面（Popup / Options / Sidepanel）统一的挂载入口。
 *
 * ## 为什么要有这个文件
 *
 * `ConfigProvider` 必须**包在**界面组件外面才能把主题与语言注入下去，而它是
 * 运行期的一个 h 调用 —— 三个 `main.ts` 各写一遍就等于三份「antd 是怎么装的」
 * 的实现，改一处漏两处。界面组件自己不去引它，是因为测试会直接 `mount(Popup)`，
 * 那时没有 ConfigProvider，组件仍然要能跑起来（用 antd 的默认主题）。
 *
 * ## 语言
 *
 * 用 `zh_CN`：不引它的话，`Empty` / `Popconfirm` / `Select` 的空态与按钮文案
 * 会是英文（"No data" / "OK" / "Cancel"）—— 与界面其余部分的中文混在一起，
 * 比样式问题更刺眼。
 *
 * ## `autoInsertSpaceInButton: false`
 *
 * antd 默认会在**两个汉字**的按钮里插一个空格（"取 消"、"保 存"），那是为了
 * 拉丁字母的排版习惯。中文界面上这个空格看起来像手抖 —— 而这个项目里
 * 两个字的按钮占绝大多数（保存 / 取消 / 删除 / 编辑 / 新增 / 测试 / 恢复…），
 * 所以全局关掉。
 *
 * ## 主题
 *
 * `usePeonTheme()` 返回 computed，`render` 里读它 ⇒ 系统深浅色切换时整棵树重渲染，
 * antd 的算法跟着换。我们自己写的元素走 `shared.css` 的媒体查询，两边同一个判据。
 *
 * ## 为什么还套了一层 `<a-app>`
 *
 * `App` 是 antd 给「命令式 API」准备的那一层：`message` / `notification` / `modal`
 * 要通过 `App.useApp()` 拿，才能**落在 ConfigProvider 的主题里**（静态 `message`
 * 在应用树之外建容器，深色模式下会弹浅色 toast）。项目的轻提示统一走它 ——
 * 见 `logic/ui-message.ts`。
 *
 * ⚠ 它会给整棵树外面加一个 `<div class="ant-app">`。三个界面的骨架都是自己定尺寸的
 *   （弹窗 360×480、侧栏 100vh、设置页 min-height: 100vh），所以多一层普通 div 不影响；
 *   反过来它还把 token 里的字体族 / 字号 / 行高继承给了整棵树，正好少写一遍。
 */
export function mountApp(App: Component) {
  const theme = usePeonTheme()

  const app = createApp({
    render: () => h(
      ConfigProvider,
      { theme: theme.value, locale: zhCN, autoInsertSpaceInButton: false },
      { default: () => h(AntApp, null, { default: () => h(App) }) },
    ),
  })

  setupApp(app)
  app.mount('#app')
}
