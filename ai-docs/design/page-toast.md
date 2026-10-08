# Page Toast · 页面顶部 Toast 设计

> mail-peon **不在 OS 层打扰**——系统通知一律不发；新邮件只用 `chrome.action` badge 提示，点击 icon = 看 Popup；自动复制反馈用本页 toast。

---

## 1. 目标

| # | 目标 |
| --- | --- |
| G1 | 替代 `chrome.notifications`：所有"我刚做了一件事"的反馈在网页内完成 |
| G2 | 验证码自动复制成功后 → 用户**立刻看到验证码** + "已复制"状态 |
| G3 | 自动复制失败 → 用户能看到代码 + 一个"复制"按钮 |
| G4 | 不抢页面焦点，不阻塞用户操作 |
| G5 | 多事件可堆叠，可单独关闭 |
| G6 | 与页面 DOM / 样式隔离（shadow DOM） |

---

## 2. 通知策略总览

| 场景 | 用户反馈 |
| --- | --- |
| **新邮件到达** | `chrome.action.setBadgeText(count)` 仅在 icon 右上角显示数字；点 icon = 看 Popup |
| **邮件已 AI 处理完**（普通邮件） | 无任何额外反馈；用户点 icon 在 Popup 里看 |
| **判定为广告** | 无任何反馈；用户可在 Popup "营销"分区翻 |
| **验证码 + 自动复制 ON（成功）** | 顶部 toast："验证码：123456 已复制到剪贴板" |
| **验证码 + 自动复制 ON（失败）** | 顶部 toast："验证码：123456（点击复制）" |
| **验证码 + 自动复制 OFF** | 顶部 toast："验证码：123456（点击复制）" + 点 Popup 卡片也有复制按钮 |

> **不再调用** `chrome.notifications`。

---

## 3. 布局 & 视觉

### 3.1 位置

```
浏览器顶部
═══════════════════════════════════════════════
          ┌─────────────────────────┐ ←──── 距 viewport top 32px
          │ 验证码：123456 已复制 ✓ │   │   ← max-width: 480px
          └─────────────────────────┘   │   ← 居中
                                        │
            页面正常内容...                │
                                        │
                                        │
```

- `position: fixed; top: 32px; left: 50%; transform: translateX(-50%)`
- `z-index: 2147483647`（最高，确保不被页面覆盖）
- 多 toast 堆叠：每条高度 ~56px + 8px 间距；超过 3 条最老的自动消失

### 3.2 视觉

- **背景** `rgba(28, 28, 30, 0.92)`，毛玻璃 `backdrop-filter: blur(20px)`
- **圆角** `12px`；**阴影** `0 8px 24px rgba(0,0,0,.15)`
- **字号** 14px / 24px line-height；验证码使用 `font-feature-settings: 'tnum'` 等宽
- **配色**（浅 / 深模式自动适配）
  - 成功：左侧 4px `#10B981` 边
  - 失败：左侧 4px `#F59E0B` 边
  - 信息：左侧 4px `#3B82F6` 边

### 3.3 内容（自动复制成功）

```
┌────────────────────────────────────────────────┐
│ ✅  GitHub · noreply@github.com                │
│    验证码  123456  已复制 ✓  [×]              │
└────────────────────────────────────────────────┘
```

- 标题行：发件人标识
- 内容行：验证码（等宽字体突出）+ 状态
- 右侧 `×` 关闭；整条可点击 → 打开 Popup 并定位该邮件

---

## 4. 动画

### 4.1 入场

```css
@keyframes toast-in {
  from { transform: translate(-50%, -120%); opacity: 0; }
  to   { transform: translate(-50%, 0);     opacity: 1; }
}
```
- 时长 `220ms`，`cubic-bezier(0.22, 1, 0.36, 1)`（顺滑减速）
- 从顶部"上方"滑下来，同时淡入

### 4.2 出场

```css
@keyframes toast-out {
  from { transform: translate(-50%, 0);    opacity: 1; }
  to   { transform: translate(-50%, -24px); opacity: 0; }
}
```
- 时长 `180ms`；向上滑出 + fade out

### 4.3 堆叠行为

- 新 toast 入场时**不会**把已有 toast 顶飞
- 新 toast 出现在现有队列**下方**（更靠近页面内容）
- 已有 toast 顺次向下平移 `translateY`，时长 `180ms`

### 4.4 暂停自动关闭

- 鼠标 hover → 暂停 5s 自动关闭
- focus 在 toast 内（点击了复制按钮）→ 同样暂停

---

## 5. 自动关闭

| 类型 | 时长 |
| --- | --- |
| 验证码相关（含验证码 / 复制状态） | **5 秒**（让用户来得及读） |
| 其他通知（理论上有，但 MVP 暂无） | 3 秒 |

> **不**主动 hover 关闭（用户已经在读了）。主动 X 关闭或到时自动关闭。

---

## 6. 点击行为

- **整条 toast 点击** → `chrome.action.openPopup()`（无 popup 权限时：发送 `mail:focus` + 通知 content script 关闭自己）
- **`×` 点击** → 只关闭这条（`stopPropagation`）
- **验证码相关带 "再复制一次" 按钮**（失败 toast）→ `navigator.clipboard.writeText(code)` + 改 toast 状态为"已复制"

> `chrome.action.openPopup` 仅 Chrome；Firefox 用 `browser.sidebarAction.open`（参考 [Browser Compat](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/browserAction/openPopup)）。MVP 用 `sendMessage` 让 Popup 自检 + `chrome.windows.create` 兜底。

---

## 7. 技术实现

### 7.1 注入方式：复用 Content Script

模板 manifest 已有 `content_scripts`（`src/contentScripts/index.ts`），匹配 `<!-- <all_urls> -->`。**MVP 直接复用**：

```
content_script (注入所有页面, idle 时只挂监听)
│
└─ onMessage('mail:toast', payload => showToast(payload))
        │
        └─ showToast: 渲染到 closed shadow root 的 host 容器
```

**Pros**：
- 不用每次 `chrome.scripting.executeScript`（权限 + 注入时机复杂）
- 内容脚本已存在，零额外依赖

**Cons**：
- 会在所有页面挂载 content script（轻量监听即可）
- 部分站点（极少见）禁用 content script → toast 不显示（这是预期行为，复制本身已落剪贴板）

> **可选优化**：manifest 改为只在 `chrome.scripting.executeScript({ files: ['toast-bundle.js'] })` 时注入；但需要 `scripting` 权限和时机管理。MVP 不做。

### 7.2 Shadow DOM 隔离

```ts
const host = document.createElement('div')
host.id = 'mail-peon-toast-host'
host.style.cssText = 'all: initial; position: fixed; top: 0; left: 0; z-index: 2147483647; pointer-events: none;'
const shadow = host.attachShadow({ mode: 'closed' })
document.documentElement.appendChild(host)
```

- `closed` shadow root → 页面 JS 读不到 toast DOM
- `pointer-events: none` 默认关闭，hover/click 时局部打开
- `all: initial` 重置 host 上的所有 CSS 继承

### 7.3 消息流

```ts
// background
sendMessage('mail:toast',
  {
    kind: 'code-copied',
    mailId: '...',
    from: 'GitHub',
    code: '123456',
    status: 'copied',          // 'copied' | 'failed'
  },
  { context: 'content-script', tabId: activeTabId }
)

// content_script
onMessage('mail:toast', (payload) => showToast(payload))
```

> "当前激活 tab" 由 `chrome.tabs.query({ active: true, currentWindow: true })` 拿到。

### 7.4 关键文件

| 文件 | 内容 |
| --- | --- |
| `src/contentScripts/toast.ts` | 渲染逻辑（shadow DOM、堆叠、自动关闭） |
| `src/contentScripts/toast.css.ts` | 样式字符串（被打包进 IIFE） |
| `src/background/notify.ts` | "对哪个 tab 弹 toast" 的判定 + `sendMessage` |
| `src/logic/notification/badge.ts` | `chrome.action.setBadgeText` 包装 |

---

## 8. 边界

| 边界 | 处理 |
| --- | --- |
| 没有激活 tab（所有窗口最小化） | 不显示 toast；只更新 badge |
| content script 未注入（如 chrome:// 页面） | 跳过 toast，不报错 |
| 同一邮件多次到达 | 已有 toast 时不再叠加；改 toast 文案为"已复制" |
| 用户焦点在 iframe 内 | 弹到顶层页面（content script 注入顶层） |
| 与页面其它 toast 冲突 | z-index 我们最高；用最高值仍可能被 `!important` 的页面 z-index 压住——可接受 |
| 移动端 popup（不太可能，但兼容） | toast 仍然显示；Popup 用 sheet 替代 |

---

## 9. 验收清单

- [ ] 新邮件到达 → icon 右上角出现数字 badge
- [ ] 点击 icon → Popup 打开，看到邮件列表
- [ ] 收到验证码 → 顶部 toast 滑下显示验证码 + "已复制"
- [ ] 5 秒后 toast 自动消失
- [ ] hover 时 toast 暂停消失
- [ ] 手动 X 关闭 → 不再出现
- [ ] 关闭自动复制 → 同样的邮件展示 toast 带 "点击复制" 按钮（弹 Popup 也仍有复制按钮）
- [ ] 多封连到 → 多条堆叠，新条出现在下方
- [ ] 在任意网页（GitHub、Bilibili、Gmail 等）toast 样式都不被页面 CSS 污染
- [ ] chrome:// 页面不报错

---

## 10. 后续读什么

- 整体 UI 流：[`./ui-flows.md`](./ui-flows.md)
- AI 总结：[`../features/02-ai-summary.md`](../features/02-ai-summary.md)
- 验证码：[`../features/05-verification-code.md`](../features/05-verification-code.md)