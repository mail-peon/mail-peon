import AntApp from 'ant-design-vue/es/app'
import staticMessage from 'ant-design-vue/es/message'

/**
 * 我们实际用到的轻提示能力。
 *
 * ⚠ **故意不用 antd 自带的 `MessageInstance`**：那个名字在 antd 里有两份互不兼容的
 *   定义（`es/message/interface.d.ts` 与 `es/message/index.d.ts`），
 *   一个是 `<a-app>` 给的实例、一个是静态 API，`duration` 的签名还不一样 ——
 *   直接写 `MessageInstance` 时「静态兜底」那句会**编译不过**（TS2322）。
 *   这里只声明真正调用的四个方法：两边都满足，调用方也拿不到用不上的东西。
 */
export interface UiMessage {
  info: (content: string, duration?: number) => void
  success: (content: string, duration?: number) => void
  warning: (content: string, duration?: number) => void
  error: (content: string, duration?: number) => void
}

/**
 * 全局轻提示（antd 的 `message`）。
 *
 * ## 为什么要有这个包装
 *
 * 项目里曾经把结果**画在页面里**（同步结果、警告、报错各一个 `a-alert`），
 * 由此产生两个具体问题：
 *
 *   1. **颜色会撒谎**。同步结果的文案里既有「拉取 3 封」也有
 *      「⚠️ 个人邮箱：无法连接中继：ws://…」，而它们曾经共用一个
 *      `type="success"` 的 Alert —— 于是**连接失败被渲染成绿色**。
 *   2. 一条一次性的操作结果会**永久占着版面**，把设置项往下推。
 *
 * 改成全局 message 之后，「这句话是什么性质」由调用方显式选择
 * （`success` / `info` / `warning` / `error`），颜色不再由渲染位置决定。
 *
 * ## 为什么不是直接 `import { message } from 'ant-design-vue'`
 *
 * 静态 `message` 在**应用树之外**创建自己的容器，拿不到 `ConfigProvider` 注入的
 * 主题 —— 深色模式下会弹出一个浅色的 toast。所以首选 `<a-app>` 提供的实例
 * （见 `mount-app.ts`），它在主题里、也带 `zh-CN`。
 *
 * ⚠ 单测里是**直接 `mount(GeneralPage)`** 的（没有 `<a-app>` 那层），此时
 *   `App.useApp()` 给回来的是一个**空对象**（`message.success` 都不存在），
 *   直接用会报「不是函数」。所以这里退回到静态 API —— 测试里通常会把本模块
 *   整个 mock 掉（见 `options/pages/__tests__/general-sync.spec.ts`），
 *   这个兜底是为了让「忘了 mock」不至于变成一堆看不懂的报错。
 */
export function useAppMessage(): UiMessage {
  const { message } = AntApp.useApp()
  return typeof message.success === 'function' ? message : staticMessage
}

/**
 * 提示停留时长（秒）。
 *
 * antd 默认 3 秒。对**报错**来说太短 —— 而报错里常常带着需要看清楚的东西
 * （`无法连接中继：ws://127.0.0.1:8787/…`、IMAP 的超时原因），
 * 3 秒读完再加去排查是不够的。成功那类仍用默认值：它只是「收到了」的确认。
 */
export const ERROR_DURATION = 8

/** 警告（例如某个账号连不上，但整体不算失败）同样需要读完的时间 */
export const WARNING_DURATION = 6
