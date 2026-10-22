# Minimal Mode · 极简模式设计

> mail-peon 的**两套运行模式之一**。极简模式是给「只想要一键类邮件」的用户准备的完整子集：
> **验证码 + 确认邮件**。另一种模式叫**自定义模式**（Feature 08 起，原「完整模式」改名）。
>
> 类型适配器的总设计见 [`../features/08-mail-types.md`](../features/08-mail-types.md)。

---

## 1. 一图概览

```
┌─ mail-peon · 极简模式 ─────────────────────────────┐
│                                                    │
│   中继推送（常驻 IDLE）                              │
│      │                                            │
│      ▼                                            │
│   拉新邮件                                         │
│      │                                            │
│      ▼                                            │
│   预筛（验证码线索 OR 确认线索）                     │
│      │                                            │
│      ├─ ❌ 都不像                                  │
│      │    └── 丢弃（不入库）                        │
│      │                                            │
│      └─ ✅ 像                                      │
│           │                                        │
│           ▼                                        │
│        极简 AI prompt：只带「验证码 + 确认」两个适配器 │
│           │                                        │
│           ├─ 两个都没命中 → 丢弃（不入库）           │
│           │                                        │
│           ├─ 验证码命中                              │
│           │    ├── 自动复制到剪贴板                   │
│           │    └── 顶部 toast「验证码 123456」        │
│           │                                        │
│           └─ 确认命中                                │
│                └── 卡片里一个「打开确认链接」按钮      │
│                                                    │
│           ▼                                        │
│        写瘦身 Mail 记录（不存正文，50 条上限）        │
└────────────────────────────────────────────────────┘
```

---

## 2. 与自定义模式的差异

> 两种模式都是完整子集，不是阶段关系。极简模式故意做得少：**只跑两个内置 UI 类型**。

| 能力 | 极简模式 | 自定义模式 |
| --- | --- | --- |
| 邮箱连接 + 增量同步 | ✅ | ✅ |
| 验证码识别 + 自动复制 | ✅ | ✅ |
| 确认邮件 + 打开链接 | ✅ | ✅ |
| 页面顶部 Toast | ✅（仅验证码） | ✅（仅验证码） |
| 自定义适配器 / 总结 | ❌ 强制关闭 | ✅ 用户配置 |
| 广告 / 紧急 / 低优先级状态标签 | ❌ 不计算 | ✅ |
| 多 PromptRule 匹配 | ❌ | ✅ |
| 排除邮箱 / 排除广告 | ❌ | ✅ |
| 动态筛选标签 | ❌（平铺列表） | ✅ |
| icon badge | ❌ | ✅ |
| 邮件正文 / 摘要入库 | ❌ | ✅ |
| 适配器配置页 | 只读（开关锁定） | ✅ 可编辑 |
| 保留数量 | 写死 50 | 用户可配 |
| 失效验证码自动删除 | ✅ | ✅ |

---

## 3. 处理流程

实现在 `src/logic/ai/pipeline.ts` 的 `processMinimal(mail)`：

```ts
async function processMinimal(mail: Mail, app: AppSettings): Promise<MailOutcome> {
  // 1. 预筛：验证码线索 OR 确认线索；都不像 → 丢弃（省一次 AI 调用）
  if (!looksLikeActionableEmail(mail))
    return 'skipped'

  // 2. 只带「验证码 + 确认」两个适配器（模式强制，不读用户的开关）
  const extracted = await extractActionableTypes(mail, settings, { adapters: [CODE, CONFIRM] })
  if (!extracted.types.length)
    return 'skipped'          // 没命中 → 丢弃，不写库

  // 3. 验证码：自动复制（尊重全局 autoCopyCode，带超时）
  const codeMatch = extracted.types.find(m => m.kind === 'code')
  const copied = codeMatch && shouldAutoCopyCode(app, null)
    ? await copyWithTimeout(notifier, codeMatch.code)
    : false

  // 4. 写瘦身记录：同一个 Mail 表，正文不存
  const minimalMail: Mail = {
    ...mail,
    snippet: '',
    bodyText: undefined,
    bodyHtml: undefined,
    stateFlags: 0,                       // 极简模式不计算状态标签
    processing: 'skipped',
    code: codeMatch?.code ?? null,
    codeExpiresAt: codeMatch?.expiry?.at,
    codeValidForSeconds: codeMatch?.expiry?.totalSeconds,
    ai: {
      types: extracted.types,            // 验证码 + 确认都可能在这里
      // 兼容字段
      code: codeMatch?.code ?? null,
      validForSeconds: codeMatch?.expiry?.totalSeconds ?? null,
    },
    copyStatus: copied ? 'copied' : codeMatch ? 'failed' : 'none',
  }
  await upsertMail(minimalMail, MINIMAL_RETENTION)

  // 只有验证码弹 toast；确认不发 toast（产品决定）
  if (codeMatch) {
    await notifySafe(notifier, {
      kind: 'code',
      mailId: minimalMail.id,
      from: toastCaption(minimalMail.from),
      code: codeMatch.code,
      status: shouldAutoCopyCode(app, null) ? (copied ? 'copied' : 'failed') : 'manual',
    })
  }

  notifier.notifyMailUpdated(minimalMail.id)
  return 'saved'
}
```

要点：

- **确认邮件也入库**，但只保留 URL / label / expiry，不存正文。
- 验证码与确认同时命中：两个都存，卡片两个面板都显示。
- 只有验证码命中才弹 toast；确认命中不弹。
- AI 失败 / 都没命中：直接丢弃，**没有 degraded 记录**。

### 3.1 预筛

```ts
const CODE_HINTS = [ /* 验证码线索，见 prefilter.ts */ ]
const CONFIRM_HINTS = [
  /confirm/i,
  /confirmation/i,
  /verify\s+your\s+(email|address)/i,
  /activate/i,
  /activation/i,
  /确认.*(邮箱|邮件|账号)/,
  /验证.*邮箱/,
  /激活/,
]

function looksLikeActionableEmail(mail): boolean {
  const haystack = `${mail.subject ?? ''} ${(mail.bodyText ?? mail.snippet ?? '').slice(0, 1000)}`
  return CODE_HINTS.some(re => re.test(haystack)) || CONFIRM_HINTS.some(re => re.test(haystack))
}
```

> 确认线索的假阳性只是白调一次 AI；假阴性会让用户**永远看不到确认邮件**，所以宁可宽松。

### 3.2 极简 AI prompt

只包含「基础输出契约 + 验证码 + 确认」两个适配器段，不包含：

- `states`（广告 / 紧急 / 低优先级）
- 总结
- 自定义适配器
- PromptRule

输出：

```json
{
  "types": [
    { "adapterId": "builtin:code", "code": { "value": "123456", "validForSeconds": 300 } },
    { "adapterId": "builtin:confirm", "confirm": { "url": "https://...", "expiresAt": "..." } }
  ]
}
```

### 3.3 保留数量

```ts
const MINIMAL_RETENTION = 50
```

极简模式写死 50 条（验证码 + 确认合计）；不暴露设置项。

---

## 4. 模式切换

| 切换方向 | 历史数据 | 未来邮件 | 适配器配置 |
| --- | --- | --- | --- |
| 极简 → 自定义 | 保留；旧记录没有 stateFlags / summary，卡片按已有 match 渲染 | 走自定义流水线，按保存的开关生效 | 恢复用户之前保存的配置 |
| 自定义 → 极简 | 保留；列表只挑 code / confirm match | 走极简流水线，强制 code + confirm | **不修改**保存的配置，只在生效层覆盖 |

**模式切换不修改已保存的适配器状态**：极简模式是 overlay（强制 code+confirm、其余关闭），
所以「切到极简看一眼，再切回自定义」不会把用户精心配的开关清掉。

---

## 5. UI

### 5.1 Options · 通用设置（极简模式）

```
┌─ 通用 ─────────────────────────────────┐
│ 模式:                                  │
│   ◉ 极简模式   ○ 自定义                │
│                                        │
│ 极简模式固定启用「验证码」和「确认邮件」，│
│ 其他适配器关闭；开关在「适配器」页锁定。 │
│                                        │
│ [✓] 验证码自动复制                      │
│                                        │
│ 账号 · me@my-domain.com                │
│ 记录: 12 条                             │
│ [清空所有数据]                          │
└────────────────────────────────────────┘
```

- 极简模式保留的页面：通用 / 账号 / **适配器（只读）** / AI 配置 / 回收站 / 关于。
- 隐藏：提示词 / 屏蔽列表（属于自定义模式的功能）。

### 5.2 Popup · 极简模式

```
┌─ mail-peon · 极简模式 ──────────────┐
│ 验证码 / 确认记录:                   │
│                                      │
│ GitHub · noreply@github.com  12:34   │
│ 验证码 123456    [已复制 ✓]          │
│                                      │
│ WakaTime · noreply@wakatime.com 10:21│
│ [ 打开确认链接 ]   wakatime.com      │
│ 23:59:12 有效                        │
│                                      │
│         [打开设置]                   │
└──────────────────────────────────────┘
```

- 平铺列表，不显示筛选 tab。
- 卡片同时显示验证码 / 确认面板（命中几个显示几个）。

---

## 6. 边界

| 场景 | 行为 |
| --- | --- |
| 没配 AI Key | Popup 顶部 CTA 跳 AI 配置 |
| AI 失败 / 没命中 | 直接丢弃：不入库、不弹 toast、没有 degraded 记录 |
| 邮件含多个验证码 | 按适配器用户补充规则选；没有规则时选与登录/验证最相关的那个 |
| 确认链接无效 | 丢弃确认 match；如果验证码也命中，仍按验证码保存 |
| 切换模式 | 不清数据；只影响未来邮件的处理方式与列表筛选 |

---

## 7. 与其他 features 的关系

| Feature | 极简模式 | 自定义模式 |
| --- | --- | --- |
| **01 邮箱连接** | 跑；增量同步；只跑 code/confirm | 跑；全量流水线 |
| **02 AI 总结** | 不跑 | 总结适配器（兜底，可关） |
| **04 排除广告** | 不存在 | 有（`Ad` 状态位） |
| **05 验证码** | 强制启用 | 默认启用 |
| **06 排除邮箱** | 不存在 | per-account |
| **08 邮件类型** | 固定 code+confirm；配置只读 | 全部适配器可配置 |

---

## 8. 后续读什么

- 邮件类型适配器：[`../features/08-mail-types.md`](../features/08-mail-types.md)
- 自定义模式的 UI：[`./ui-flows.md`](./ui-flows.md)
- 验证码机制：[`../features/05-verification-code.md`](../features/05-verification-code.md)
- AI Provider：[`../features/02-ai-summary.md`](../features/02-ai-summary.md)
