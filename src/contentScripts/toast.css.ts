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

.title {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  line-height: 18px;
  color: rgba(245, 245, 247, 0.72);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.title .icon { flex: 0 0 auto; }

.content {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 2px;
  font-size: 14px;
  line-height: 24px;
}

.label { color: rgba(245, 245, 247, 0.72); flex: 0 0 auto; }

.code {
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-feature-settings: 'tnum';
  font-size: 16px;
  letter-spacing: 0.5px;
  font-weight: 600;
  color: #ffffff;
  flex: 0 0 auto;
}

.status { color: rgba(245, 245, 247, 0.6); flex: 1 1 auto; }

button.copy {
  flex: 0 0 auto;
  margin-left: auto;
  appearance: none;
  border: 1px solid rgba(255, 255, 255, 0.24);
  background: rgba(255, 255, 255, 0.08);
  color: #ffffff;
  font-size: 12px;
  line-height: 1;
  padding: 6px 10px;
  border-radius: 8px;
  cursor: pointer;
  font-family: inherit;
}

button.copy:hover { background: rgba(255, 255, 255, 0.16); }
button.copy:active { transform: translateY(1px); }

button.close {
  flex: 0 0 auto;
  align-self: flex-start;
  appearance: none;
  border: 0;
  background: transparent;
  color: rgba(245, 245, 247, 0.5);
  font-size: 16px;
  line-height: 1;
  padding: 8px 10px;
  cursor: pointer;
  font-family: inherit;
}

button.close:hover { color: #ffffff; }

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
