import type { ThemeConfig } from 'ant-design-vue/es/config-provider/context'
import type { ComputedRef } from 'vue'
import { usePreferredDark } from '@vueuse/core'
import theme from 'ant-design-vue/es/theme'
import { computed } from 'vue'

/**
 * Ant Design Vue 的主题配置（三个界面共用）。
 *
 * ## 为什么是「跑在 JS 里」而不是一份 css
 *
 * antd v4 的样式由 CSS-in-JS 在运行期算出来，`ConfigProvider` 的 `theme` 是**唯一**
 * 入口。所以这里的 token 一改，Button / Input / Menu / Table 全是同一个色。
 *
 * ## 与 `shared.css` 的分工
 *
 * 这里管 **antd 组件**，`shared.css` 管**我们自己写的元素**（卡片右上角的垃圾桶、
 * 倒计时进度条）。两边的取值必须对齐 —— 一边用 `colorPrimary` 的蓝、另一边写死
 * Tailwind 的蓝，放在一起看就是「色相差一点点」的渲染错误。
 *
 * ⚠ 深色模式的判据必须与 `shared.css` 的 `@media (prefers-color-scheme: dark)`
 *   一致（都是「跟随系统」）。做成「用户手选主题」的话，两边就要共享一份状态，
 *   而目前没有这个需求。
 */

/**
 * 主色。
 *
 * 用 antd 自己的默认蓝而不是项目早期的 Tailwind 蓝（#3b82f6）：主色要同时出现在
 * antd 组件和我们自己写的链接 / 文字按钮上，选 antd 的默认值可以少一层「看起来
 * 像没对齐」的怀疑。
 */
export const MP_PRIMARY_COLOR = '#1677ff'

/** 三个界面共用的字体栈（与 `shared.css` 的 `html, body` 保持一致） */
const FONT_FAMILY = `-apple-system, BlinkMacSystemFont, 'Segoe UI', 'PingFang SC', 'Hiragino Sans GB', 'Microsoft YaHei', sans-serif`

/**
 * 弹窗只有 360px 宽，设置页又是「配置」而非「阅读」场景 ——
 * antd 默认的 14px / 32px 行高在这么窄的地方会显得很空。
 */
export function usePeonTheme(): ComputedRef<ThemeConfig> {
  const prefersDark = usePreferredDark()

  return computed<ThemeConfig>(() => ({
    algorithm: prefersDark.value ? theme.darkAlgorithm : theme.defaultAlgorithm,
    token: {
      colorPrimary: MP_PRIMARY_COLOR,
      colorInfo: MP_PRIMARY_COLOR,
      fontFamily: FONT_FAMILY,
      fontSize: 12,
      // 30px 的控件比默认 32px 更贴合弹窗，又不至于像 `size="small"`（24px）那样挤
      controlHeight: 30,
      borderRadius: 8,
      // 卡片/弹窗的圆角比按钮大一点，层次更清楚
      borderRadiusLG: 12,
    },
    components: {
      /*
       * ⚠ 这里的字段是**组件级 token**，不是随手写的 css 属性名 ——
       *   写错了 TypeScript 会拦下（`OverrideToken` 是精确类型）。
       *   本版本的 antd 对 Table / Tabs / Card 还没暴露组件级 token
       *   （`ComponentToken` 是空接口），所以那几处的密度在 `shared.css` 里
       *   用 `.ant-*` 前缀选择器调 —— 那边也留了说明。
       *
       * 菜单项左右留白收窄，侧边栏 148px 宽时文字能有更多空间。
       */
      Menu: {
        itemMarginInline: 4,
      },
    },
  }))
}
