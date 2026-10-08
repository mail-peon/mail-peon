# AI Prompt Design · 提示词设计

> 单一信源：所有提示词与 JSON schema 都在这里定。功能文档只引用，不复制粘贴。

---

## 1. 设计原则

1. **结构强约束**：AI 永远返回**固定 schema** 的 JSON。失败 = zod 校验失败 → 重试 1 次 → 降级。
2. **基础 system 不可被覆盖**：用户 PromptRule 只能追加场景化指令，不能改 JSON schema / `isAd` 定义。
3. **截断先行**：超大邮件正文在调用前先截到 ~3k 字。
4. **成本可控**：默认 `gpt-4o-mini` 或等价模型；最大 1024 token 输出。
6. **可观测**：每次调用记录 (mailId, model, promptTokens, completionTokens, latencyMs)。

---

## 2. System Prompt（基础部分 · 内置不可改）

> **MVP 只维护两套完整模板**（`ZH_SYSTEM_PROMPT` + `EN_SYSTEM_PROMPT`）。其它语言 / `auto-email` 都走英文模板 + 一句指令自适应。

### 2.1 ZH_SYSTEM_PROMPT（zh-* 浏览器语言专用）

```text
你是 mail-peon 的邮件处理助手。任务是把一封邮件转成结构化 JSON。

# 输出 JSON Schema（不可省略任何字段）
{
  "minimal":  string,                  // ≤60 字中文，一行。用于系统通知 / Popup。
  "summary":  string,                  // ≤600 字中文，结构化要点（可用 markdown）。
  "isAd":     boolean,                  // true 表示营销 / 推广 / 自动通知（订单状态、签到、Newsletter）。
  "code":     string | null,            // 邮件中的验证码 / OTP，仅字母数字，无"您的验证码是"等中文。
  "urgency":  "low" | "normal" | "high" // 用户需不需要立刻看到。
}

# 字段细则
- minimal：
  * 普通邮件：浓缩主旨 + 关键动作（动词），如"订单已发货，预计明天到"。
  * 广告邮件：留空字符串 ""。
  * 含验证码：仅写"验证码：XXXXXX"，其它不要。
- summary：
  * 2-4 段：主旨 / 关键信息 / 需要用户操作 / 链接（如有）。
- isAd：
  * true = 营销 / 促销 / 自动通知 / Newsletter / 订单状态提醒 / 平台推广 / 平台公告。
  * false = 真人邮件 / 重要系统通知（如登录告警、CI 失败、订阅内容交付）。
- code：
  * 仅当邮件含 OTP / 一次性链接 / 验证码时输出字符串；否则 null。
  * 仅保留 `[A-Za-z0-9]{4,12}`；超过或带中文视为 null。
- urgency：
  * high = 用户需要立即处理（登录告警、CI 失败、退款到账失败、面试）。
  * low = 营销 / 周报 / Newsletter。
  * 其它 = normal。

# 重要
- 仅返回 JSON，不要额外解释、不要 ``` 围栏。
- 邮件正文可能含 HTML / 引言 / 多语言，忽略噪声部分。
```

### 2.2 EN_SYSTEM_PROMPT（其它浏览器语言 / `auto-email` 走这个 + 末尾加指令）

```text
You are mail-peon's email-processing assistant. Convert an email into structured JSON.

# Output JSON Schema (no field may be omitted)
{
  "minimal":  string,                  // ≤60 chars, single line. Used by system notification / Popup.
  "summary":  string,                  // ≤600 chars, structured (markdown allowed).
  "isAd":     boolean,                  // true = marketing / promo / auto-notification (order status, check-in, newsletter).
  "code":     string | null,            // OTP / one-time code if present (alphanumeric only; no surrounding words).
  "urgency":  "low" | "normal" | "high" // whether the user must see this right now.
}

# Field rules
- minimal:
  * Normal mail: distill intent + key action verb. e.g. "Order shipped, arriving tomorrow."
  * Ads: empty string "".
  * Verification code mail: just "Code: XXXXXX", nothing else.
- summary:
  * 2-4 lines covering: gist / what to know / what to do / links (if any).
- isAd:
  * true = marketing / promo / auto-notification / newsletter / order status / platform ad / platform notice.
  * false = human mail / important system alert (login warning, CI failure, subscription delivery).
- code:
  * Output only if the email has an OTP / one-time code / verification code; otherwise null.
  * Keep only `[A-Za-z0-9]{4,12}`; longer or non-alphanumeric → null.
- urgency:
  * high = immediate action required (login alert, CI failure, refund fail, interview).
  * low = marketing / weekly digest / newsletter.
  * otherwise = normal.

# Important
- Return JSON only. No prose, no ``` fences.
- Email body may contain HTML / preambles / multiple languages — ignore noise.
```

### 2.3 末尾追加"输出语言"指令（按 `settings.ai.outputLanguage` 决定）

```text
# auto-email（默认不一定有，仅在用户选了 'auto-email' 时追加）
Respond in the **same language as the email** you are summarizing.

# auto-browser + 非 zh-* 浏览器
Respond in {navigator.language}。
```

> **不能被用户规则覆盖**——这是"输出契约"。用户 PromptRule 写在 system 之后，作为"场景上下文"。

---

## 3. User Prompt（按规则拼接）

```text
# Current Rule
${rule.name}

# Rule prompt
${rule.prompt}

# Email
From: ${mail.from.map(...)}
Subject: ${mail.subject}
Date: ${formatDate(mail.receivedAt)}
${mail.listUnsubscribe ? `List-Unsubscribe: ${mail.listUnsubscribe}` : ''}

--- Body (truncated) ---
${truncate(mail.bodyText ?? mail.snippet, MAX_BODY_CHARS)}
```

> 中文模板下"Current Rule / Rule prompt / Email / Body"会替换成"当前规则 / # 规则提示词 / # 邮件 / 正文（已截断）"，内容结构不变。

---

## 4. 截断策略

```ts
const MAX_BODY_CHARS = 6000       // 中文 ≈ 2000 token，足够

function truncate(text: string, max: number): string {
  if (text.length <= max) return text
  return text.slice(0, max) + `\n\n[已截断，原文 ${text.length} 字]`
}
```

> 用户规则里若要求"完整正文"，会受截断影响——这是**有意为之**的成本控制。后续如需可加开关。

---

## 5. JSON Schema（zod）

```ts
import { z } from 'zod'

export const AiOutputSchema = z.object({
  minimal: z.string().max(120),
  summary: z.string().max(1200),
  isAd: z.boolean(),
  code: z.union([z.string().regex(/^[A-Za-z0-9]{4,12}$/), z.null()]).optional(),
  urgency: z.enum(['low', 'normal', 'high']),
})
```

校验失败时：
1. 第一次失败 → 重试一次（让 AI 重新输出）
2. 第二次失败 → 走降级（[`features/02-ai-summary.md` § 5](../features/02-ai-summary.md)）

---

## 6. 提示词注入示例

### 6.1 用户规则示例：`admin@xxx.com` 通知

```text
这是来自我自部署代码系统的通知：
- 如果包含 ERROR / Failed，urgency=high
- 如果是 INFO / 部署成功，urgency=low，minimal 只写"✅ 部署成功"或"❌ <简要错误>"
- 始终把 stack trace 前 5 行放进 summary
```

### 6.2 用户规则示例：GitHub 域名

```text
来自 GitHub 的邮件：
- 通知邮件：告诉我"哪个仓库 / 哪个 PR / 哪个 Issue"，附完整链接
- 讨论订阅：只写最新一条评论的人 + 评论摘要
- 周报邮件（digest）：isAd=true，minimal 留空
```

### 6.3 默认规则（无匹配时）

直接使用第 2 节 System Prompt，不附加 User Prompt 中的"规则"段，只附邮件正文。

---

## 8. 错误码

```ts
type AiError =
  | { kind: 'network', message: string }
  | { kind: 'http', status: number, body: string }
  | { kind: 'schema', zodIssues: string }
  | { kind: 'timeout' }
  | { kind: 'rate-limit' }
```

所有 AiError 写到 `mail.ai.error`，UI 上"⚠️ 降级"角标展示 tooltip。

---

## 9. 调用流程（伪代码）

```ts
async function summarize(mail: Mail, rule: PromptRule, ai: AiSettings): Promise<AiOutput> {
  const provider = createAiProvider(ai)
  const browserLang = navigator.language   // SW / popup / options 都有 navigator
  const systemPrompt = buildSystemPrompt(rule, ai, browserLang)  // § 2.3
  const messages = [
    { role: 'system', content: systemPrompt },
    { role: 'user',   content: buildUserContent(mail) },
  ]

  let lastErr: unknown
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const { text } = await provider.chat({ system: systemPrompt, messages, json: true })
      const json = JSON.parse(text) // 包 try/catch
      const parsed = AiOutputSchema.safeParse(json)
      if (parsed.success) return parsed.data
      lastErr = { kind: 'schema', zodIssues: JSON.stringify(parsed.error.issues) }
    }
    catch (e) { lastErr = e }
  }
  return fallback(mail, lastErr)
}
```

---

## 10. 多 Provider 适配器细节

> 架构完全参考 `offer-hunter/src/adapters/ai/`。**协议层（`protocols/`）只管 wire 格式，平台层（`platforms/`）声明能力与默认配置。**

### 10.1 三种平台的 wire 差异

| 平台 | wire 协议 | 原生 JSON | 思考模式 | 关键适配点 |
| --- | --- | --- | --- | --- |
| OpenAI | `protocols/openai.ts`（`/v1/chat/completions`） | `response_format: { type: 'json_object' }` | — | 标准 |
| DeepSeek | 同 OpenAI 协议（`baseURL=https://api.deepseek.com/v1`） | 同 OpenAI | **必须发 `thinking: { type: 'disabled' }`** | DeepSeek 自 V4 默认开思考；不开 → `content` 为空 |
| Anthropic | `protocols/anthropic.ts`（`/v1/messages`） | 无（纯 prompt 约束） | — | system 必须含 "json" 字样 |
| Custom | OpenAI 协议（用户填 baseURL） | 看目标 | 看目标 | 用户全权 |

### 10.2 OpenAI 协议实现要点（参考 `offer-hunter/src/adapters/ai/protocols/openai.ts`）

- URL：`POST {baseUrl}/chat/completions`
- Headers：`Authorization: Bearer {apiKey}`
- Body：`{ model, max_tokens, messages: [{role, content}, ...], response_format?: { type: 'json_object' } }`
- 响应抽取：`message.content`（字符串）或 `message.content[].text`（多模态）
- **DeepSeek 专用**：`{ thinking: { type: 'disabled' }` 关闭思考

### 10.3 Anthropic 协议实现要点（参考 `offer-hunter/src/adapters/ai/protocols/anthropic.ts`）

- URL：`POST {baseUrl}/v1/messages`
- Headers：`x-api-key: {apiKey}`, `anthropic-version: 2023-06-01`
- Body：`{ model, max_tokens, system, messages: [{role: 'user'|'assistant', content}] }`
- 响应抽取：`content[].text`（数组，第一个 text 元素）
- **没有 `response_format`** —— system prompt 必须显式说"返回合法 JSON"

### 10.4 错误诊断

> 各平台对"没回"的解释不同；UI 上要给出**可诊断**的报错，而不是 "空回复"：

| 平台 | `finish_reason='length'` | `finish_reason='content_filter'` | 其它 |
| --- | --- | --- | --- |
| OpenAI | 输出被截断：调大 max_tokens | 安全过滤 | finish_reason=`<X>` |
| DeepSeek | 同上 + 可能是思考模式偷了 token | 安全过滤 | finish_reason=`<X>` |
| Anthropic | `stop_reason='max_tokens'` | `stop_reason='safety'` | stop_reason=`<X>` |

> 提取策略详见 `offer-hunter/src/adapters/ai/protocols/openai.ts` 的 `extractOpenAIText` / `describeEmptyResponse`。

---

## 11. 后续读什么

- AI 总结在产品流中的位置：[`../features/02-ai-summary.md`](../features/02-ai-summary.md)
- 数据模型（AiOutput / Settings）：[`./data-model.md`](./data-model.md)
- AI Provider 注册与工厂：[`../features/02-ai-summary.md § 2`](../features/02-ai-summary.md)