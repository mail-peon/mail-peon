# Minimal Mode · 极简模式设计

> mail-peon 的**两套运行模式之一**——极简模式。**它不是 MVP 的第一步**，是给"**只想要验证码提取**"的用户准备的**完整子集**。MVP 同时发布极简 + 完整两种模式；用户根据需要二选一。
>
> 详细决策见 [`../decisions/open-questions.md` Q18](../decisions/open-questions.md)。本文是落地方案。

---

## 1. 一图概览

> **极简模式是为只想要验证码提取的用户准备的完整子集**——而不是"完整功能"的简化版或第一步。

```
┌─ mail-peon ───────────────────────────────────────┐
│                                                    │
│   IMAP 心跳 (5 min)                                │
│      │                                            │
│      ▼                                            │
│   拉新邮件 (UID > lastSeenUid)                     │
│      │                                            │
│      ▼                                            │
│   预筛 (subject 含 验证码 / code / OTP?            │
│          或 body 含 \d{4,8}?)                       │
│      │                                            │
│      ├─ ❌ 不像有验证码                              │
│      │    └── 丢弃 (不入库)                         │
│      │                                            │
│      └─ ✅ 像有验证码                               │
│           │                                        │
│           ▼                                        │
│        极简 AI prompt: "提取验证码"                │
│           │                                        │
│           ├─ code = null                             │
│           │    └── 丢弃 (不入库)                     │
│           │                                        │
│           └─ code = "XXXXXX"                        │
│                │                                    │
│                ▼                                    │
│             自动复制到剪贴板                         │
│                │                                    │
│                ▼                                    │
│             顶部 toast: "验证码 123456 已复制 ✓"    │
│                │                                    │
│                ▼                                    │
│             写最小 Mail 记录到 IDB                   │
│             (只存 from/subject/code/receivedAt)    │
└────────────────────────────────────────────────────┘
```

---

## 2. 与"完整功能"的差异

> **两种模式都是完整子集**——不是阶段关系。极简模式**自身就完整可用**，只是故意做得少。

| 能力 | 极简模式 | 完整功能 |
| --- | --- | --- |
| 邮箱连接 + IMAP 增量同步 | ✅ | ✅ |
| 验证码识别 + 自动复制 | ✅ | ✅ |
| 页面顶部 Toast 反馈 | ✅ | ✅ |
| **AI 总结 / 广告判定 / 紧急程度** | ❌ | ✅ |
| **多 PromptRule 匹配** | ❌ | ✅ |
| **排除邮箱列表** | ❌ | ✅ |
| **排除广告开关** | ❌ | ✅ |
| **Popup 邮件流（重要 / 全部 / 营销）** | ❌ | ✅ |
| **Popup 仅验证码列表** | ✅ | ✅ |
| **icon badge 数字** | ❌ | ✅ |
| **邮件正文 / 摘要 入库** | ❌ | ✅ |
| **设置项：AI 配置 / 提示词 / 屏蔽** | ❌ 隐藏 | ✅ 全部 |
| **保留数量配置** | ❌（写死 50 条验证码） | ✅ 用户可配 |

---

## 3. 数据模型

> **不引入新 schema**：用**同一个 `Mail` 表**，未用字段就是 `null` / 空字符串。极简模式写入时**只填部分字段**。

### 3.2 写入策略

```ts
async function purseMinimal(raw: RawMail, account: MailAccount): Promise<void> {
  const parsed = await simpleParser(raw.source)

  // 预筛：不明显有验证码的 → 丢弃
  if (!looksLikeCodeEmail(parsed)) return

  // AI 极简 prompt 提取
  const { code } = await extractCodeOnly(parsed, account)

  // AI 没找到 → 丢弃
  if (!code) return

  // 自动复制
  const copied = await copyToClipboard(code)

  // 写最小记录
  const mail: Mail = {
    id: mailKey(account.id, raw.messageId ?? nanoid()),
    accountId: account.id,
    from: parsed.from?.value ?? [],
    to: [],
    subject: parsed.subject ?? '',
    snippet: '',
    bodyText: undefined,
    bodyHtml: undefined,
    receivedAt: (parsed.date as Date)?.getTime() ?? Date.now(),
    processing: 'skipped',
    ai: undefined,
    copyStatus: copied ? 'copied' : 'failed',
    read: false,
    dismissed: undefined,
    messageId: raw.messageId,
    listUnsubscribe: undefined,
    ruleId: undefined,
  }
  await upsertMail(mail, retention = 50)
  await toastCodeCaptured(mail)
}
```

### 3.3 预筛（不调 AI 也能省）

```ts
const CODE_HINTS = [
  /验[证碼码]/,
  /code/i,
  /otp/i,
  /\b\d{4,8}\b/,         // 短数字串
]

function looksLikeCodeEmail(parsed: ParsedMail): boolean {
  const haystack = `${parsed.subject ?? ''} ${(parsed.text ?? '').slice(0, 1000)}`
  return CODE_HINTS.some(re => re.test(haystack))
}
```

> 不命中 → **不调 AI，不入库**。这是极简模式省 token / 省钱的关键。

### 3.4 极简 AI prompt

```ts
const MINIMAL_SYSTEM_PROMPT = `你是验证码提取助手。阅读邮件正文（可能含 HTML、噪声），从其中找到一次性验证码 / OTP / 一次性链接。
- 如果有：返回 JSON { "code": "<字母数字>" }
- 如果没有：返回 JSON { "code": null }
- 仅返回 JSON，不要解释。`
```

调用 < 200 token 输入 / < 30 token 输出，**几乎免费**。

### 3.5 保留数量

> 极简模式写死 50 条验证码（最新的 50）。不需要用户配——配置项在完整模式下才有。

```ts
const MINIMAL_RETENTION = 50
```

---

## 4. UI

### 4.1 Options · 通用设置（极简模式下）

```
┌─ 通用 ─────────────────────────────────┐
│ 模式:                                  │
│   ◉ 极简模式（仅验证码）              │
│   ○ 完整功能（AI 总结 + 屏蔽 + …）    │
│                                        │
│ [✓] 验证码自动复制                       │
│                                        │
│ ───────────────────                    │
│ 账号 · me@my-domain.com                │
│ 验证码记录: 12 条                       │
│ [清空所有数据]                          │
└────────────────────────────────────────┘
```

> 极简模式下**只显示这一页**；切到完整功能后其它子页（账号 / 提示词 / AI 配置 / 屏蔽列表）才出现。

### 4.2 Options · 通用设置（完整模式下）

> 见 [`./ui-flows.md § 4.6`](./ui-flows.md)。

### 4.3 Popup · 极简模式

```
┌─ mail-peon · 极简模式 ──────────────┐
│ 验证码记录:                          │
│                                      │
│ GitHub · noreply@github.com  12:34 │
│ 验证码 123456    [已复制 ✓]          │
│                                      │
│ 阿里云 · alert@aliyun.com    10:21 │
│ 验证码 888432    [复制]              │
│                                      │
│         [打开设置]                  │
└──────────────────────────────────────┘
```

> 只显示最近 50 条验证码（按时间倒序）；不显示未含验证码的邮件。

### 4.4 Popup · 完整模式

> 见 [`./ui-flows.md § 1`](./ui-flows.md)（当前设计不变）。

---

## 5. 模式切换行为

| 切换方向 | 历史数据 | 未来邮件 |
| --- | --- | --- |
| 极简 → 完整 | 保留；新视图会显示"该邮件为极简模式捕获，无摘要" | 走完整流水线 |
| 完整 → 极简 | 保留；新视图只挑有 `code` 字段的展示 | 走极简流水线 |

> **不需要清数据**：切换模式只影响"现在起"的处理方式。

---

## 6. 与极简模式相关的边界

| 场景 | 行为 |
| --- | --- |
| 用户没配 AI Key（极简模式下也得有 AI 才能提取 code） | Options 顶部显示"⚠️ 验证码提取需要先配置 AI Key（点击设置）" |
| AI 调用失败 | 走与完整模式相同的降级（落 `mail.ai = { degraded: true, error }`），但因为极简模式下 AI 输出是 `{ code }`，降级意味着这条验证码**没拿到**——记录不入库，toast 也不弹；建议改成"记下来但标红"，让用户去 Sidepanel 找 |
| 用户切到极简但 AI Key 空 | Popup 顶部给出 CTA："需要先在设置里配 AI Key 才能工作" |
| 邮件含多个验证码（罕见） | 取第一个；记到 `mail.code` |

---

## 7. 与其他 features 的关系

| Feature | 极简模式 | 完整模式 |
| --- | --- | --- |
| **01 邮箱连接** | 跑；增量同步；只预筛 + 提取 code | 跑；全量流水线 |
| **02 AI 总结** | 不跑 / 跑极简 prompt | 跑完整 prompt |
| **04 排除广告** | 不存在（极简模式没广告 / 非广告邮件混合显示） | 默认 ON |
| **05 验证码** | 强制 ON | 默认 ON |
| **06 排除邮箱** | 不存在 | per-account |

---

## 8. 实施清单

- [ ] `AppSettings.minimalMode: boolean` 默认 `true`
- [ ] `purseMinimal(raw, account)` 函数（含预筛 + 极简 AI + 自动复制 + toast）
- [ ] `extractCodeOnly(parsed, account)` 用极简 prompt
- [ ] Popup / Sidepanel 根据 `minimalMode` 切布局
- [ ] Options 路由：根据 `minimalMode` 隐藏子页
- [ ] 切换模式时不需清数据
- [ ] 单测覆盖 `looksLikeCodeEmail` / `purseMinimal` 决策路径

---

## 9. 后续读什么

- **完整模式**的 UI：[`./ui-flows.md`](./ui-flows.md)
- 验证码机制：[`../features/05-verification-code.md`](../features/05-verification-code.md)
- 邮箱连接：[`../features/01-mail-inbox-connect.md`](../features/01-mail-inbox-connect.md)
- AI Provider：[`../features/02-ai-summary.md`](../features/02-ai-summary.md)
- 两种模式的总体定位：[`../00-overview.md` § 1](../00-overview.md)