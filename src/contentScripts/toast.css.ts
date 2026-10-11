/**
 * Toast 样式（`design/page-toast.md § 3`）。
 *
 * ⚠ 刻意写成**字符串**而不是 `.css` 文件：
 *   1. 内容脚本的 shadow root 是 `mode: 'closed'`，外部样式表选不进去 —— 样式必须
 *      在 shadow root 内部（`<style>` 标签或 `adoptedStyleSheets`）；
 *   2. 走 Vite 的 `?inline` 导入也能拿到字符串，但那会多一层构建期魔法，
 *      而这几十行 CSS 本来就不需要预处理。
 *
 * 用 CSS 变量承载主题色：浅 / 深模式各给一套值（`prefers-color-scheme`），
 * 组件本身不关心当前是哪个模式。
 */
export const TOAST_CSS = `
:host {
  all: initial;
}

*, *::before, *::after {
  box-sizing: border-box;
}

.stack {
  position: fixed;
  top: 32px;
  left: 50%;
  transform: translateX(-50%);
  display: flex;
  flex-direction: column;
  gap: 8px;
  z-index: 2147483647;
  pointer-events: none;
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', 'PingFang SC',
    'Hiragino Sans GB', 'Microsoft YaHei', sans-serif;
}

.toast {
  pointer-events: auto;
  display: flex;
  align-items: stretch;
  width: max-content;
  max-width: min(480px, calc(100vw - 32px));
  min-width: 280px;
  background: rgba(28, 28, 30, 0.92);
  color: #f5f5f7;
  border-radius: 12px;
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.15);
  backdrop-filter: blur(20px);
  -webkit-backdrop-filter: blur(20px);
  overflow: hidden;
  cursor: pointer;
  animation: toast-in 220ms cubic-bezier(0.22, 1, 0.36, 1);
}

.toast.leaving {
  animation: toast-out 180ms ease-in forwards;
}

.accent {
  width: 4px;
  flex: 0 0 4px;
}

.toast[data-status='copied'] .accent { background: #10B981; }
.toast[data-status='failed'] .accent { background: #F59E0B; }
.toast[data-status='manual'] .accent { background: #3B82F6; }

.body {
  flex: 1 1 auto;
  padding: 10px 12px 12px;
  min-width: 0;
}

/*
 * 第一行：发件人 · 发件邮箱 + 右端的关闭按钮。
 *
 * 用一行 flex 而不是把关闭按钮绝对定位：绝对定位要给它留出一条 padding，
 * 而标题是 ellipsis 的 —— 留窄了就会压住省略号，留宽了第一行白白变矮。
 */
.head {
  display: flex;
  align-items: flex-start;
  gap: 6px;
}

.title {
  flex: 1 1 auto;
  min-width: 0;
  font-size: 12px;
  line-height: 18px;
  color: rgba(245, 245, 247, 0.72);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.content {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 2px;
  font-size: 14px;
  line-height: 24px;
}

.label { color: rgba(245, 245, 247, 0.72); flex: 0 0 auto; }

/*
 * 验证码：整条 toast 里唯一必须被读到的内容，字号刻意压过其它所有文字
 * （发件人 12px、标签 14px、它 22px + 加粗）。
 */
.code {
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-feature-settings: 'tnum';
  font-size: 22px;
  line-height: 28px;
  letter-spacing: 1px;
  font-weight: 700;
  color: #ffffff;
  flex: 0 0 auto;
}

/* 失败说明（只有失败态有，在第三行）。它不伸展，后面的复制按钮紧跟着它 */
.status { color: rgba(245, 245, 247, 0.6); flex: 0 0 auto; }

/*
 * 第三行（只有自动复制失败时才有）：失败说明 + 复制按钮。
 *
 * 单独占一行是为了让第二行永远只有「验证码 + 数字」这一件事 ——
 * 失败说明挤在那一行会把主体压小（用户报过）。
 */
.footer {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 4px;
  font-size: 13px;
  line-height: 18px;
}

/*
 * 「复制」是**文字按钮** —— 与 Popup 列表项里那个（MailListItem.vue 的 .copy）
 * 同一套做法：无边框、无底色，读起来是左边那句话的延续（「验证码 123456 复制」），
 * 而不是一个需要去找的控件。
 *
 * ⚠ padding: 0 + height: auto：带内边距的方块按钮会把这一行撑高，
 *   而它只是那句话说完了的一个动作。
 * ⚠ 蓝色写死（与 .toast[data-status='manual'] .accent 同一个值）：
 *   这是页面里的 shadow DOM，拿不到 Popup 那边的 --mp-accent。
 *
 * ⚠ 本文件整份样式是一个模板字符串：注释里**不能写反引号**，会把它截断。
 */
button.copy {
  flex: 0 0 auto;
  appearance: none;
  border: 0;
  background: transparent;
  height: auto;
  padding: 0;
  color: #3B82F6;
  font-family: inherit;
  font-size: 13px;
  line-height: inherit;
  cursor: pointer;
  transition: color 0.12s;
}

button.copy:hover { color: #60A5FA; text-decoration: underline; }
button.copy:active { color: #2563EB; }

/*
 * 手动复制成功：绿色加粗。它**替换掉**按钮（见 toast.ts 的 markCopied），
 * 所以与 .copy 共用字号 / 行高 —— 盒模型差一点，换的那一下这一行就会跳。
 */
.copy-done {
  flex: 0 0 auto;
  font-size: 13px;
  font-weight: 600;
  line-height: inherit;
  color: #10B981;
}

/*
 * 自动复制成功的第三行：「√ 已复制」。
 *
 * ⚠ 刻意是**灰色、不加粗**：自动复制成功是默认预期，只需要一句安静的确认。
 *   绿色加粗（.copy-done）留给「用户刚点了复制」那一下 —— 那是他做的一个动作，
 *   值得一个明确的结果；两者混用会让每一次收验证码都像发生了什么大事。
 */
.copied-hint {
  flex: 0 0 auto;
  color: rgba(245, 245, 247, 0.6);
}

/*
 * 关闭按钮：贴在第一行右端。
 *
 * ⚠ 负的上下 / 右侧外边距把它「顶到角上」而不撑高第一行：
 *   padding 只有 0 4px（8px 宽），负外边距再吃掉 .body 的一部分 padding，
 *   于是 × 的视觉位置在右上角、标题行的行高仍是 18px。
 *
 * ⚠ 注释里**不能写反引号**：整份样式是一个模板字符串，反引号会直接把它截断。
 */
button.close {
  flex: 0 0 auto;
  margin: -2px -6px 0 0;
  appearance: none;
  border: 0;
  background: transparent;
  color: rgba(245, 245, 247, 0.5);
  font-size: 16px;
  line-height: 18px;
  padding: 0 4px;
  border-radius: 6px;
  cursor: pointer;
  font-family: inherit;
}

button.close:hover {
  color: #ffffff;
  background: rgba(255, 255, 255, 0.08);
}

@keyframes toast-in {
  from { transform: translateY(-120%); opacity: 0; }
  to   { transform: translateY(0);     opacity: 1; }
}

@keyframes toast-out {
  from { transform: translateY(0);     opacity: 1; }
  to   { transform: translateY(-24px); opacity: 0; }
}

@media (prefers-reduced-motion: reduce) {
  .toast, .toast.leaving { animation-duration: 1ms; }
}
`
