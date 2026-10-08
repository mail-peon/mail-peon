# Feature 06 · 排除邮箱（per-account 本地屏蔽）

> 对应里程碑：**M4**。目标：在某个账号的"排除列表"里的发件人 / 域名，**该账号收到的该邮件完全跳过**——不调 AI、不展示、不弹通知、不进任何视图。本邮箱账号不变（不影响服务器端）。
>
> **设计决策**：每个 `MailAccount` 拥有**自己的** `blockedList`（详见 [`../decisions/open-questions.md` Q7](../decisions/open-questions.md)）。

---

## 1. 目标

| # | 目标 |
| --- | --- |
| G1 | 每个 `MailAccount` 维护独立的 `blockedList`（地址 / 域名） |
| G2 | 拉取到的邮件先经过**该账号**的列表过滤；命中的**完全跳过**（不入库 / 不调 AI / 不通知） |
| G3 | Options 提供 CRUD（按账号 tab 切换） |
| G4 | 全局 `blockedEnabled` 开关（默认 ON；OFF 时所有账号的列表都失效） |
| G5 | **仅本地**：服务器端邮箱不受影响（用户仍能在邮箱客户端看到） |

---

## 2. 数据模型

```ts
type BlockedEntry =
  | { kind: 'email',  value: string }   // 'noreply@spam.com'
  | { kind: 'domain', value: string }   // 'tracker.com'

interface MailAccount {
  // ...
  blockedList: BlockedEntry[]          // ← 在 MailAccount 上
}

interface AppSettings {
  // ...
  blockedEnabled: boolean              // ← 全局开关（默认 true）
}
```

完整定义见 [`../design/data-model.md` § 1](../design/data-model.md) 与 [`../design/storage.md`](../design/storage.md)。

---

## 3. 匹配逻辑

> 与全局列表一致；只是数据来源从 `settings.blockedList` 改到 `account.blockedList`。

```ts
function isBlocked(mail: Mail, list: BlockedEntry[]): boolean {
  const fromAddr = mail.from[0]?.address?.toLowerCase() ?? ''
  const fromDomain = fromAddr.split('@')[1] ?? ''
  return list.some(b => {
    const v = b.value.toLowerCase()
    if (b.kind === 'email')  return fromAddr === v
    if (b.kind === 'domain') return fromDomain === v || fromDomain.endsWith('.' + v)
    return false
  })
}
```

> 域名支持二级后缀：`tracker.com` 同时匹配 `a.tracker.com` / `b.c.tracker.com`。

---

## 4. 处理流程（在 `mailbox.syncAccount` 内）

```
listRecent → [RawMail]
  │
  ▼
for each raw:
  parsed = parser.parse(raw)
  mail = normalize(parsed)
  │
  ▼
  if appSettings.blockedEnabled && isBlocked(mail, account.blockedList):
      continue                       ← 完全跳过
  │
  ▼
  dedup + upsertMail(mail)           ← IDB，含 100 滚动
  │
  ▼
  enqueueAi(mail)
```

**注意**：被排除的邮件**不影响** 心跳下一次拉取——同一邮件再次被 IMAP 返回时仍会被 skip（不会"累积"在数据库里）。

---

## 5. UI（Options · 屏蔽列表页 · per-account tab）

```
┌─ 屏蔽列表 ──────────────────────────────┐
│ 总开关: [✓] 启用排除                     │
│                                          │
│ 当前账号: [工作邮箱 ▾]   ← MVP 单账号    │
│                                          │
│ + 新增屏蔽                                │
│  类型: [邮箱 ▾] 值: [_________]      │
│                                          │
│ 当前列表                                  │
│  • noreply@spam.com     [删除]          │
│  • @tracker.com         [删除]          │
│                                          │
│ [批量粘贴]                                │
└──────────────────────────────────────────┘
```

> **MVP** UI 只支持当前账号；如果用户将来加第二个账号，此页加账号 tab。
> 支持批量粘贴（每行一项，自动识别含 `@` 当作 email，否则当作 domain）。

---

## 6. 与其它规则的关系

| 功能 | 优先级 | 说明 |
| --- | --- | --- |
| **排除邮箱（per-account）** | 最高 | **不入库、不 AI、不通知** |
| 广告过滤 | 次之 | 入库 + AI，但不弹通知、不进主列表 |
| 验证码自动复制 | 最低 | 入库 + AI，按开关决定 |

---

## 7. 验收清单

- [ ] 在账号 A 添加 `noreply@spam.com` → A 收到的该发件人邮件在 Popup / Sidepanel / badge / 通知均不可见
- [ ] 添加 `@tracker.com` → A 收到的该域名所有邮件同样屏蔽
- [ ] 切换到账号 B（UI 暂不可见，但数据上可加）→ B 收到的同一发件人**不受影响**（per-account 隔离）
- [ ] 关闭总开关 → 之前屏蔽的邮件再次心跳时仍**不会回填**（这是预期）；手动"清空邮件列表"后才回到主列表
- [ ] 批量粘贴混合条目能正确识别类型
- [ ] 服务器端邮箱不受影响（在 Gmail 里仍能看到）

---

## 8. 后续读什么

- 完整数据模型：[`../design/data-model.md`](../design/data-model.md)
- 决策记录：[`../decisions/open-questions.md` Q7](../decisions/open-questions.md)