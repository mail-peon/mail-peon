# Feature 04 · 排除广告 / 营销邮件

> 对应里程碑：**M3**。目标：开启后被判为广告的邮件**完全静默**——AI 不总结、不弹窗、不进主列表；可在 Popup "营销"分区查看。

---

## 1. 目标

| # | 目标 |
| --- | --- |
| G1 | 全局开关 `excludeAds`，**默认 ON** |
| G2 | AI 输出 `isAd=true` 的邮件 → 静默处理（不入主列表 / 不弹通知） |
| G3 | Popup / Sidepanel 提供"营销邮件"分区可看（仍能看到，但视觉弱化） |
| G4 | 关掉开关 → 历史 / 新邮件中的广告回到主列表 |
| G5 | 单条 PromptRule 可通过 `alwaysSkipAd` **强制不视为广告**（覆盖 isAd） |

---

## 2. 行为定义

```
收到新邮件 → AI 输出 { isAd: true }
       │
       ▼
如果 settings.excludeAds === true
       │
       ├─ mail.ai = result（保留，方便查看"营销"分区）
       ├─ mail.processing = 'sent'
       ├─ mail._visibility = 'ad'  ← 内部标记
       └─ 不发系统通知
       │
       ▼
否则
       │
       ├─ 正常弹通知 / 正常展示
       └─ mail._visibility = 'normal'
```

> 关键点：**仍然入库 + 仍然 AI**。只是 UI 上不进主列表、不发通知。这样用户可以随时在"营销"分区找回。

---

## 3. 广告判定的优先级

```
如果 rule.alwaysSkipAd === true   → isAd 强制 false
否则如果 rule.prompt?.forceAd === true → isAd 强制 true (规则内可声明)
否则使用 AI 输出 isAd
```

> `alwaysSkipAd` 写在 PromptRule 上，让"用户主动认领的发件人"绕过广告过滤。

---

## 4. AI 侧的判定提示词

> 默认 system 提示词里已经写明：
>
> ```
> isAd: 若属于营销 / 促销 / 自动通知（如：订单状态、签到提醒、Newsletter、平台推广），true；否则 false
> ```
>
> 这部分不可被用户规则改写（保证 Output Schema 不被破坏）。

详细提示词见 [`design/ai-prompt-design.md`](../design/ai-prompt-design.md)。

---

## 5. UI 设计

### Popup / Sidepanel

```
┌─ 邮件 ──────────────────────────────┐
│ [全部] [重要] [验证码] [营销(3)]    │ ← tab
├─────────────────────────────────────┤
│  ┌────────────────────────────────┐ │
│  │ 邮件卡片                         │ │
│  │ from / subject / minimal         │ │
│  │ [详情] [复制] [已读]            │ │
│  └────────────────────────────────┘ │
└─────────────────────────────────────┘
```

- 「营销」tab：弱化视觉（透明度 0.6 / 灰边）
- 默认 tab = 「重要」= `urgency !== 'low'` 的全部邮件（按时间倒序）

### Options

- 一个 `Switch`：`排除广告 / 营销邮件，默认开启`
- 开关下方小字说明："被判为广告的邮件仍会被 AI 处理，可在弹窗「营销」分区查看。"

---

## 6. 存储

不新增字段，复用：

- `Mail.ai.isAd`
- `Mail._visibility: 'normal' | 'ad' | 'code' | 'blocked' | 'pending'`（参考 [`design/data-model.md`](../design/data-model.md) § 4）
- `Settings.excludeAds: boolean`

> `_visibility` 是派生字段，UI 计算即可，不必存。MVP 不存，避免脏数据。

---

## 7. 验收清单

- [ ] 默认开启；Options 关闭 → 营销邮件进入主列表
- [ ] 营销邮件入库但**不弹通知**
- [ ] 「营销」tab 能看到所有 isAd=true 的
- [ ] 给"自己的广告"发件人写一条规则（`alwaysSkipAd`） → 该邮件不再被屏蔽
- [ ] 关闭开关后，之前已判为广告的邮件回到主列表

---

## 8. 后续读什么

- 验证码静默：[`05-verification-code.md`](./05-verification-code.md)
- 完全屏蔽：[`06-blocked-senders.md`](./06-blocked-senders.md)