# Feature 05 · 验证码自动复制

> 对应里程碑：**MVP 必做**——两种模式（极简 / 完整）共用此功能。
>
> 极简模式下这是**唯一**对外功能；完整模式下与广告过滤、提示词、排除列表并列。
>
> 目标：默认开启下，AI 识别到验证码 → 自动复制进剪贴板 → 在**当前页面顶部弹 toast 反馈**；关闭时同样弹 toast 带"再复制一次"按钮，Popup 卡片也保留复制按钮。

---

## 1. 目标

| # | 目标 |
| --- | --- |
| G1 | 全局开关 `autoCopyCode`，**默认 ON**（极简模式下强制为 true） |
| G2 | AI 输出 `code` 字段非空时 → 自动复制 → 顶部 toast "验证码：XXX 已复制 ✓" |
| G3 | 自动复制**失败**时 → 顶部 toast "验证码：XXX（点击复制）" + Popup 卡片保留复制按钮 |
| G4 | 关闭自动复制开关 → 顶部 toast 同样弹出（带"再复制"按钮），Popup 卡片也有复制按钮 |
| G5 | 单条 PromptRule 的 `alwaysCopyCode` 可强制开启本规则时自动复制（即便全局关） |
| G6 | 验证码视觉标识（即使没复制成功，UI 也要识别出来） |
| G7 | **极简模式**下：邮件正文根本不存，只存验证码；详细见 [`../design/minimal-mode.md`](../design/minimal-mode.md) |

> **不调用 `chrome.notifications`**。所有反馈走 [`../design/page-toast.md`](../design/page-toast.md) 定义的页面顶部 toast。

---

## 2. 决策表

> `autoCopy` = `settings.autoCopyCode || rule.alwaysCopyCode`

| autoCopy | AI.code 有值 | Toast | Popup 列表 | Popup 复制按钮 |
| --- | --- | --- | --- | --- |
| ✅ + 复制成功 | ✅ | "验证码：XXX 已复制 ✓" | 进"验证码"分区 | ❌ |
| ✅ + 复制失败 | ✅ | "验证码：XXX（点击复制）" 失败样式 | 进"验证码"分区 | ✅ |
| ✅ | ❌ | （无 toast） | — | — |
| ❌ | ✅ | "验证码：XXX（点击复制）" 信息样式 | 进"验证码"分区 | ✅ |
| ❌ | ❌ | （无 toast） | — | — |

> "验证码"分区让用户能找回历史验证码（譬如复制失败、错过了 toast）。

---

## 3. 复制实现

```ts
async function copyToClipboard(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text)
    return true
  }
  catch { return false }
}
```

> 注意：`navigator.clipboard.writeText` 要求 page 是 focused 的，**MV3 SW 中可能失败**。解决方案：
> 1. **首选**——SW 中先尝试 `navigator.clipboard.writeText`（Chrome MV3 SW 拥有用户激活态窗口时可写，多数情况下能成功）。
> 2. 失败时 → 通过 `webext-bridge` 把 `mail:copy-code` 投递给 **content_script**，由它在当前页面里执行 `writeText`（页面已 focus，最稳）。
> 3. 再失败 → toast 显示"复制失败"，等用户点 toast 内的"再复制一次"按钮（在页面 DOM 内执行，几乎必成功）。

伪代码：

```ts
// background
async function onAiResult(mail, output) {
  const autoCopy = settings.autoCopyCode || (pickedRule?.alwaysCopyCode ?? false)
  const tab = await getActiveTab()

  if (!output.code) return   // 没验证码，不弹 toast

  let copied = false
  if (autoCopy) {
    copied = await copyToClipboard(output.code)
    if (!copied) {
      // 推给 content_script 再试一次（页面已 focus）
      sendMessage('mail:copy-code',
        { mailId: mail.id, code: output.code },
        { context: 'content-script', tabId: tab.id })
    }
  }

  // 弹 toast（成功 / 失败 / 手动三态）
  sendMessage('mail:toast', {
    kind: 'code',
    mailId: mail.id,
    from: `${mail.from[0]?.name} <${mail.from[0]?.address}>`,
    code: output.code,
    status: autoCopy ? (copied ? 'copied' : 'failed') : 'manual',
  }, { context: 'content-script', tabId: tab.id })
}

// content_script
onMessage('mail:copy-code', async ({ data }) => {
  await navigator.clipboard.writeText(data.code)
})

onMessage('mail:toast', (payload) => showToast(payload))
```

---

## 4. AI 侧提示词

默认 system 提示词里的要求：

```
- 若邮件中有验证码 / 校验码 / OTP / 一次性链接：
    code 字段填入识别到的字符串（仅数字 / 字母 + 数字）
    minimal 字段仅写"验证码：XXXXXX"，不写其他内容
- 若无验证码：code 字段填 null
```

> **关键**：要求 AI **只输出验证码字符串**，不要带"您的验证码是"等中文。MVP 用正则 `[A-Z0-9]{4,8}` 兜底提取，保证即便 AI 给一句话也能匹配出来。

---

## 5. UI

### 5.1 页面顶部 Toast（详见 [`../design/page-toast.md`](../design/page-toast.md)）

**自动复制成功：**

```
┌────────────────────────────────────────────────┐
│ ✅  GitHub · noreply@github.com                │
│    验证码  123456  已复制 ✓       [×]           │
└────────────────────────────────────────────────┘
```

**自动复制失败 / 手动复制：**

```
┌────────────────────────────────────────────────┐
│ ⚠  GitHub · noreply@github.com                 │
│    验证码  123456  [点击复制]      [×]         │
└────────────────────────────────────────────────┘
```

- 整条点击：打开 Popup 并定位该邮件
- "点击复制"按钮：调用 content_script 内的 `clipboard.writeText` → toast 改为"已复制"态

### 5.2 Popup / Sidepanel 邮件卡片（含验证码）

```
┌────────────────────────────────────┐
│ GitHub · noreply@github.com  ✕    │
├────────────────────────────────────┤
│ Subject                             │
│ 你的验证码：123456                  │
│                                     │
│ Code                                │
│ 123456                [复制]       │
│                                     │
│ Summary                             │
│ （无）                              │
│                                     │
│ [在邮箱中打开]  [标记已读]         │
└────────────────────────────────────┘
```

### 5.3 Sidepanel「验证码」分区

- 顶部一行提示："最近 X 小时内收到的验证码，点击复制"
- 列表项：邮件标题 + code + 复制按钮 + 时间

---

## 6. 存储

不新增字段，复用：

- `Mail.ai.code: string | null`
- `Mail.copyStatus: 'none' | 'copied' | 'failed'`
- `Settings.autoCopyCode: boolean`
- `PromptRule.alwaysCopyCode?: boolean`

---

## 7. 边界 & 异常

| 场景 | 处理 |
| --- | --- |
| AI 输出 code 但长度异常（>20 / 含非数字字母） | 当作 `code = null`，走普通邮件流（不弹 toast） |
| 用户焦点不在任何窗口 | SW 中 `writeText` 失败 → 推到 content_script 重试 |
| 同一封邮件多次到达（重发 / 重试） | 已复制过的不再复制；toast 不重复弹；`copyStatus` 保留 |
| 用户改全局开关 | 不重处理已发邮件；新邮件走新规则 |
| 内容脚本未注入（chrome:// 页面） | 跳过 toast；`mail.copyStatus = 'failed'`；用户去 Popup 复制 |
| 无激活 tab（所有窗口最小化） | 跳过 toast；不报错；badge 数字照常更新 |

---

## 8. 验收清单

- [ ] 收到含 OTP 的邮件 → 自动复制（开关 ON）
- [ ] 开关 ON 时收到 OTP → 顶部 toast 滑下显示"验证码：XXX 已复制 ✓"
- [ ] 开关 ON + 复制失败 → toast 显示"（点击复制）"，点按钮再试成功
- [ ] 开关 OFF 时收到 OTP → toast 同样弹出（带"再复制"），Popup 卡片也有"复制"按钮
- [ ] toast 不挡住 Popup 内容、不抢焦点
- [ ] "验证码"分区始终能找到历史验证码（即便错过了 toast）
- [ ] 单条规则 `alwaysCopyCode: true` → 即使全局关也自动复制
- [ ] chrome:// 等不支持 content script 的页面不报错（toast 跳过）

---

## 9. 后续读什么

- 完全屏蔽：[`06-blocked-senders.md`](./06-blocked-senders.md)
- AI 提示词：[`../design/ai-prompt-design.md`](../design/ai-prompt-design.md)
- 页面 toast 设计：[`../design/page-toast.md`](../design/page-toast.md)