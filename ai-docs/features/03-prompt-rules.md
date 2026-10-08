# Feature 03 · 多提示词 + 收件邮箱匹配

> 对应里程碑：**M3**。目标：用户可以写多份提示词，根据发件人邮箱 / 域名匹配；最终提示词 = 基础系统提示词 + 用户规则提示词。

---

## 1. 目标

| # | 目标 |
| --- | --- |
| G1 | 用户在 Options 维护 N 条 PromptRule |
| G2 | 每条规则匹配"发件人邮箱"或"域名"（如 `@github.com`） |
| G3 | AI 处理时按"匹配优先级"挑一条规则作为提示词输入 |
| G4 | 没有任何规则匹配 → 用内置"全局默认"规则 |
| G5 | 规则可"启用 / 禁用"，禁用的不参与匹配 |

---

## 2. 数据模型

```ts
interface PromptRule {
  id: string                        // nanoid
  name: string                      // 例: 'GitHub 通知'
  enabled: boolean
  matchers: Matcher[]               // 多匹配（任一命中即匹配）
  prompt: string                    // 用户写的提示词
  // 可选扩展
  alwaysCopyCode?: boolean          // 不论全局开关，本规则强制自动复制验证码
  alwaysSkipAd?: boolean            // 本规则始终认为不是广告
  createdAt: number
  updatedAt: number
}

type Matcher =
  | { kind: 'email', value: string }    // 精确匹配：'admin@xxx.com'
  | { kind: 'domain', value: string }   // 域名后缀：'github.com'
  | { kind: 'regex', value: string }    // 高级：正则
```

> 用户不需要写"全局默认"——它内置在 `logic/settings/defaults.ts`。

---

## 3. 匹配优先级

对每封邮件按以下顺序找**第一条命中**的规则：

```
1. Matcher.kind === 'email' 精确匹配
2. Matcher.kind === 'domain' 后缀匹配
3. Matcher.kind === 'regex'   正则匹配
5. 内置默认规则
```

**规则本身的顺序**由用户在 UI 拖拽控制（拖到顶 = 优先）；MVP 可用"按 createdAt 升序"作为兜底。

伪代码：

```ts
function pickRule(mail: Mail, rules: PromptRule[]): PromptRule {
  const fromAddr = mail.from[0]?.address?.toLowerCase() ?? ''
  const fromDomain = fromAddr.split('@')[1] ?? ''

  for (const r of rules) {
    if (!r.enabled) continue
    for (const m of r.matchers) {
      if (m.kind === 'email' && fromAddr === m.value.toLowerCase()) return r
      if (m.kind === 'domain' && fromDomain === m.value.toLowerCase()) return r
      if (m.kind === 'regex' && new RegExp(m.value, 'i').test(fromAddr)) return r
    }
  }
  return defaultRule
}
```

---

## 4. 提示词组装

最终传给 AI 的 messages：

```
system = 基础系统提示词（保证 JSON 输出 schema）
       + '\n\n# 当前规则: ' + rule.name
       + '\n\n' + rule.prompt
```

详见 [`design/ai-prompt-design.md`](../design/ai-prompt-design.md)。

> 规则提示词**覆盖层**而非附加。意思是：用户写的提示词会"替换"通用指令，但不能改"输出 schema"那部分（基础 system 始终保留）。

---

## 5. UI（Options · 提示词页）

- 列表：规则卡片（名称 + 匹配模式 + 启用开关 + 摘要预览）
- 操作：新增 / 编辑 / 删除 / 上移下移
- 编辑表单：
  - 名称
  - 匹配模式（多行，每行一种；UI 给常用类型快捷入口）
  - 提示词 textarea（带"插入模板片段"按钮：验证码提取 / 广告判定 / 总结要点）
  - 高级：alwaysCopyCode / alwaysSkipAd 勾选

> **MVP 简化**：规则顺序 = 创建时间；alwaysCopyCode / alwaysSkipAd 暂不暴露。

---

## 6. 默认规则内容（内置）

```text
你是一个邮件处理助手。
请阅读邮件内容并按 JSON schema 输出：
{
  "minimal":  "≤60 字中文，告诉用户这封邮件在讲什么",
  "summary":  "≤600 字中文，结构化要点",
  "code":     "若邮件中有验证码则提取，否则 null",
  "isAd":     "若属于营销 / 促销 / 自动通知，true；否则 false",
  "urgency":  "low | normal | high"
}
- 若判断为广告，则 minimal 留空字符串。
- 若含验证码，则 minimal 仅写"验证码：XXXXXX"。
- 仅返回 JSON，不要多余说明。
```

详细提示词见 [`../design/ai-prompt-design.md`](../design/ai-prompt-design.md)。

---

## 6.5 多 Provider 提示词差异

> 用户选的 AI 平台**可能影响提示词的某些细节**。`prompt-build` 必须按平台能力做适配，**用户写的规则不变**：

| 平台 | 原生 JSON | 思考模式 | 提示词需要做的调整 |
| --- | --- | --- | --- |
| OpenAI (`openai`) | ✅ | ❌ | 标准 system prompt，调用时带 `response_format: { type: 'json_object' }` |
| DeepSeek (`deepseek`) | ✅（需 "json" 词） | ⚠ 默认 ON → **必须发 `thinking: { type: 'disabled' }`** | — |
| Anthropic (`anthropic`) | ❌ | ❌ | system prompt **必须含** "请返回合法 JSON" 字样（提示 Anthropic 自觉遵循） |

> Anthropic 接入方式详见 `offer-hunter/src/adapters/ai/protocols/anthropic.ts`。

---

## 7. 跨上下文消息

| Channel | Payload |
| --- | --- |
| `rules:list` | `void` → `PromptRule[]` |
| `rules:upsert` | `PromptRule` |
| `rules:delete` | `{ id }` |

---

## 8. 验收清单

- [ ] 添加一条规则匹配 `admin@xxx.com` → 该发件人的邮件使用该提示词
- [ ] 添加一条规则匹配 `@github.com` → 该域名所有邮件用该提示词
- [ ] 禁用某条规则 → 该规则不再匹配
- [ ] 删除某条规则 → 该规则的邮件回到默认规则
- [ ] 没有命中 → 用默认规则
- [ ] 邮件正文被截断时，规则提示词仍能影响输出

---

## 9. 后续读什么

- 广告判定：[`04-exclude-ads.md`](./04-exclude-ads.md)
- 验证码：[`05-verification-code.md`](./05-verification-code.md)
- 提示词完整设计：[`../design/ai-prompt-design.md`](../design/ai-prompt-design.md)