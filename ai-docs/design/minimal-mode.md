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
│   中继推送（常驻 IDLE）                              │
│      │                                            │
│      ▼                                            │
│   拉新邮件 (UID > cursor.uid)                      │
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
| **Popup 邮件流（重要 / 全部 / 验证码 / 营销）** | ❌ | ✅ |
| **Popup 仅验证码列表** | ✅ | ✅ |
| **icon badge 数字** | ❌ | ✅ |
| **邮件正文 / 摘要 入库** | ❌ | ✅ |
| **设置项：AI 配置** | ✅ 保留（提取验证码的前提） | ✅ |
| **设置项：提示词 / 屏蔽列表** | ❌ 隐藏（属于完整模式的功能） | ✅ 全部 |
| **设置项：回收站** | ✅ 保留（自动删除往这里放东西） | ✅ |
| **保留数量配置** | ❌（写死 50 条验证码） | ✅ 用户可配 |
| **失效验证码自动删除** | ✅（默认开） | ✅ |

---

## 3. 数据模型

> **不引入新 schema**：用**同一个 `Mail` 表**，未用字段就是 `null` / 空字符串。极简模式写入时**只填部分字段**。

### 3.2 写入策略

实现在 `src/logic/ai/pipeline.ts` 的 `processMinimal(mail)`：

```ts
async function processMinimal(mail: Mail, app: AppSettings): Promise<MailOutcome> {
  // 1. 预筛：不明显有验证码的 → 直接丢弃（省一次 AI 调用）
  if (!looksLikeCodeEmail(mail))
    return 'skipped'

  // 2. AI 极简 prompt 提取。⚠ 没配 Key 也丢弃（记 warn，不报错）
  const extracted = await extractCodeOnly(mail, await readAiSettings())
  if (!extracted)
    return 'skipped'          // 拿不到验证码 → 丢弃，**不写库**
  const { code, validForSeconds } = extracted

  // 3. 自动复制（极简模式恒为 true；带超时，失败不影响入库）
  const copied = await copyWithTimeout(notifier, code)

  // 4. 写**瘦身**记录：同一个 Mail 表，未用字段留空
  const minimalMail: Mail = {
    ...mail,
    snippet: '',
    bodyText: undefined,
    bodyHtml: undefined,
    processing: 'skipped',
    code,                                        // 顶层判据（UI / badge 用）
    codeExpiresAt: deriveCodeExpiresAt(mail, validForSeconds),
    codeValidForSeconds: validForSeconds ?? undefined,
    ai: {
      minimal: `验证码：${code}`,
      summary: '',
      isAd: false,
      code,
      validForSeconds,
      urgency: 'high',
    },
    copyStatus: copied ? 'copied' : 'failed',
  }
  await upsertMail(minimalMail, MINIMAL_RETENTION)   // 50
  await notifySafe(notifier, { kind: 'code', … })
  return 'saved'
}
```

与早期草图的差别（都是改过的）：

| | 早期草图 | 现在 |
| --- | --- | --- |
| 函数名 | `purseMinimal(raw, account)` | `processMinimal(mail)` |
| 提取 | `extractCodeOnly(parsed, account)` → `{ code }` | `extractCodeOnly(mail, settings)` → `MinimalExtraction \| null`，含 `validForSeconds` |
| `ai` 字段 | `undefined` | **真的写一个 `ai` 对象**（`minimal` / `code` / `validForSeconds` / `urgency: 'high'`） |
| 保留数量 | `upsertMail(mail, retention = 50)` | `upsertMail(mail, MINIMAL_RETENTION)` |
| AI 失败 | 「走与完整模式相同的降级」 | **直接丢弃** —— 极简模式没有 `degraded` 记录，因为它的价值只有验证码 |

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

> **⚠️ 已修正**：极简模式隐藏的是**属于完整模式功能的页面**（提示词 / 屏蔽列表），
> 而**配置前提**必须保留 —— 没有「账号」页加不了邮箱，没有「AI 配置」提取不了验证码。
> 原文写「只显示这一页」时把「配置项」和「功能」混为一谈了，照原文实现的极简模式
> **根本没法用**。极简模式实际保留 **5** 页：通用 / 账号 / AI 配置 / **回收站** / 关于。
>
> ⚠️ 「回收站」是后来加的，它**在两种模式下都显示**，因为它不是「功能」而是**数据出口**：
> 「失效验证码自动删除」默认开着，会往回收站里放东西；极简模式藏掉这一页，
> 用户就找不到那些自动消失的验证码了 —— 而那正是最需要回收站的时候。
>
> 另外「通用」页里的开关也要按模式过滤：极简模式只留「验证码自动复制」，
> 广告排除 / Badge / 弹窗默认 Tab / 保留数量都不显示（它们对极简模式无意义）。

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
| 用户没配 AI Key | **Popup 顶部**显示 CTA「⚠️ 验证码提取需要先配置 AI Key」+ 按钮跳设置。<br>⚠️ 早期文档说这个 CTA 在 **Options** 顶部，实际在 **Popup** 顶部（`popup/Popup.vue`） |
| AI 调用失败 / 没提取到验证码 | **直接丢弃**该邮件：不入库、不弹 toast。极简模式**没有** `degraded` 记录 —— 它的价值只有验证码，留一条没验证码的记录没有意义（完整模式才有降级记录） |
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
- [x] `processMinimal(mail)` 函数（含预筛 + 极简 AI + 自动复制 + toast）
- [ ] `extractCodeOnly(parsed, account)` 用极简 prompt
- [ ] Popup / Sidepanel 根据 `minimalMode` 切布局
- [x] Options 路由：极简模式隐藏**功能页**（提示词 / 屏蔽列表），保留**配置页**
      （账号 / AI 配置）—— 见上文 § 4.1 的修正说明
- [ ] 切换模式时不需清数据
- [x] 单测覆盖 `looksLikeCodeEmail` / `processMinimal` 决策路径

---

## 9. 后续读什么

- **完整模式**的 UI：[`./ui-flows.md`](./ui-flows.md)
- 验证码机制：[`../features/05-verification-code.md`](../features/05-verification-code.md)
- 邮箱连接：[`../features/01-mail-inbox-connect.md`](../features/01-mail-inbox-connect.md)
- AI Provider：[`../features/02-ai-summary.md`](../features/02-ai-summary.md)
- 两种模式的总体定位：[`../00-overview.md` § 1](../00-overview.md)