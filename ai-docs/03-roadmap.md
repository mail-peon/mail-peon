# 03 · 路线图

> 把 6 个功能切成 4 个实现里程碑。**MVP 一次发布**，同时包含**极简 + 完整两种模式**；用户根据需要切换。
>
> M1-M4 是**实现顺序**（不是发布阶段，也不是模式分界）。两种模式的核心代码（`purseMinimal` / `summarize`）一起写。

---

## 总览

```
MVP = M1 + M2 + M3 + M4 一次发布；两套模式都可用
─────────────────────────────────────────────────
M1  邮箱接通            → IDB + IMAP adapter + UID 增量同步
M2  AI 多 Provider     → OpenAI/DeepSeek/Anthropic/Custom + 极简/完整两套 prompt
M3  完整模式 UI         → Popup 邮件流 + 提示词 + 广告屏蔽 + 排除列表
M4  极简模式 UI         → Popup 仅验证码 + Options 精简
```

> 实际上 M1 / M2 / M3 / M4 不会做孤岛；某些跨越要拆开做（比如"极简 AI prompt" 在 M2 末尾就有雏形，但极简 UI 单独算 M4）。一切以**MVP 一次完整发布**为目标。

---

## M1 · 邮箱接通

**目标**：极简模式 + 完整模式都需要的底层能力（IMAP 适配器 + UID 增量同步 + IDB 持久化）落地。

**功能范围**：
- **MailProvider 适配器** + MVP 实现 IMAP + 用户名密码（`src/adapters/mail/providers/imap/`）
- 账号 CRUD（host / port / user / password / TLS）
- 后台心跳（`chrome.alarms`，每 5 分钟一次）
- **首次连上只记 UIDNEXT**，不拉任何历史；之后 `listSince(lastSeenUid)` 增量
- **UIDVALIDITY 检测**（邮箱重建时清零 lastSeenUid + 提示用户）
- **IndexedDB 持久化**：`accounts` / `rules` / `mails` / `settings` / `meta` 仓库（`src/logic/store/`）
- `ensureStoreReady()` 初始化门闸
- 一次性迁移代码搭好（如果将来从 chrome.storage.local 迁过来）—— 首次运行标记完成

**涉及文档**：
- [`features/01-mail-inbox-connect.md`](./features/01-mail-inbox-connect.md)
- [`design/storage.md`](./design/storage.md)
- [`design/data-model.md`](./design/data-model.md) § 1 / § 2 / § 3

**验收**：
- [ ] 新增一个测试邮箱账号，能看到"测试通过"
- [ ] **首次心跳**只记游标、不拉任何邮件
- [ ] 后台开始**增量**拉取新邮件
- [ ] UIDVALIDITY 变化 → 警告 + 清零 lastSeenUid
- [ ] 关闭浏览器 → 重开仍能拉取（IndexedDB 持久化 OK）
- [ ] IDB 单测覆盖 80%（`openDb` / `put` / `iterate` / `runTx` / `retryable`）
- [ ] MailProvider 注册表按目录聚合（新增 provider 不改注册表）

---

## M2 · AI 多 Provider + 极简/完整两套 prompt

**目标**：完整模式跑全套 prompt + JSON 输出；极简模式跑"提取 code"极简 prompt。两套共一套**多 Provider 适配器**。

**功能范围**：
- **AI Provider 多平台**：OpenAI / DeepSeek / Anthropic / Custom（镜像 offer-hunter/adapters/ai/）
- 协议层（`protocols/openai.ts`、`protocols/anthropic.ts`） + 平台层（`platforms/<id>/index.ts`）
- AI Provider 配置（baseURL + key + model）
- 完整模式 prompt（ZH + EN 两套，详见 [`design/ai-prompt-design.md § 2`](./design/ai-prompt-design.md)）
- **极简模式 prompt**（1-2 句，只问"提取 code"），详见 [`design/minimal-mode.md § 3.4`](./design/minimal-mode.md)
- 单封邮件 AI 处理流水线：预处理（截断）→ 调用 → zod 校验 → 落库
- AI 输出语言（Q17）：`auto-browser` / `auto-email` 二选一
- AI 失败降级（完整模式仍能展示邮件基础信息）

**涉及文档**：
- [`features/02-ai-summary.md`](./features/02-ai-summary.md)
- [`features/05-verification-code.md`](./features/05-verification-code.md)
- [`design/ai-prompt-design.md`](./design/ai-prompt-design.md)
- [`design/minimal-mode.md`](./design/minimal-mode.md) § 3.4

**验收**：
- [ ] 在 4 个 AI 平台各跑一次"测试连通"
- [ ] **完整模式**：邮件走完整 prompt，输出 `minimal / summary / isAd / code / urgency`
- [ ] **极简模式**：邮件走极简 prompt，输出 `{ code }`；不含 code 的邮件**不入库**
- [ ] DeepSeek 默认关闭思考模式（否则 content 为空）
- [ ] AI 输出语言按用户设置切换（auto-browser / auto-email）
- [ ] AI 失败时（完整模式）仍能看到邮件基础信息

---

## M3 · 完整模式的 UI + 提示词 + 屏蔽

**目标**：把完整模式的所有功能搬到 UI 上；用户能写 PromptRule、能开广告屏蔽、能维护排除列表。

**功能范围**：
- PromptRule CRUD（名称、匹配模式、提示词、启用、alwaysCopyCode / alwaysSkipAd）
- 规则匹配器（精确邮箱 > 域名 > 正则 > 全局默认）
- 广告判定开关（默认 ON）+ AI 判定逻辑
- **per-account** 排除邮箱列表（`MailAccount.blockedList`）→ 完全跳过
- Popup / Sidepanel 邮件流 UI（重要 / 验证码 / 营销 三 tab）
- icon Badge：`chrome.action.setBadgeText`；广告 / 已复制验证码不计入
- **页面顶部 Toast**（用常驻 content_script 渲染）：验证码自动复制反馈
- 保留数量配置（默认 100；200 / 500 / 1000 / 无限）
- 显示存储用量

**涉及文档**：
- [`features/03-prompt-rules.md`](./features/03-prompt-rules.md)
- [`features/04-exclude-ads.md`](./features/04-exclude-ads.md)
- [`features/06-blocked-senders.md`](./features/06-blocked-senders.md)
- [`design/ui-flows.md`](./design/ui-flows.md) § 1.1 / § 2 / § 3 / § 4
- [`design/page-toast.md`](./design/page-toast.md)

**验收**：
- [ ] 添加一条规则匹配 `admin@xxx.com` → 该邮件使用对应提示词
- [ ] 添加一条规则匹配 `@github.com` → 域名匹配 OK
- [ ] 邮件被判定为广告 → 不进主列表、不增加 badge
- [ ] 关闭"排除广告"开关 → 同样邮件回到主列表
- [ ] 添加 `noreply@spam.com` 到账号 A 的排除列表 → 仅账号 A 的该发件人被屏蔽
- [ ] 新邮件到达 → icon 右上角 badge +1；点 icon → Popup 打开
- [ ] 顶部 toast 在当前页面滑下显示
- [ ] 调整保留数量 → 下次写时滚动淘汰

---

## M4 · 极简模式 UI + 模式切换

**目标**：极简模式的 Popup 只显示验证码列表；Options 切到极简时只显示最简页面；用户在两套之间无感切换。

**功能范围**：
- Popup 根据 `minimalMode` 切布局（极简：仅验证码；完整：3 tab 邮件流）
- Options 路由根据 `minimalMode` 隐藏子页（极简：只显示"通用"；完整：5 个子页）
- 模式切换不需清数据（保留历史；只影响未来邮件）
- 极简模式下 Options 顶部 CTA："⚠️ 验证码提取需要先配置 AI Key"（如果 key 为空）

**涉及文档**：
- [`design/minimal-mode.md`](./design/minimal-mode.md) § 4
- [`design/ui-flows.md`](./design/ui-flows.md) § 1 / § 4

**验收**：
- [ ] 切到极简模式 → Popup 只显示验证码列表
- [ ] 切到极简模式 → Options 侧边栏只显示"通用"
- [ ] 切到完整模式 → Popup 恢复 3 tab 邮件流
- [ ] 切到完整模式 → Options 侧边栏显示完整导航
- [ ] 极简模式下 AI Key 为空 → Options 顶部出现 CTA

---

## 风险 & 已决

| 风险 | 影响 | 缓解 |
| --- | --- | --- |
| IMAP 在 MV3 SW 中频繁重建连接 | 心跳延迟 / 性能 | 用 alarms 批量处理 + 单次连接抓增量 |
| AI 输出格式不合法 | 流程卡住 | zod 强校验 + 失败重试 1 次 + 降级 |
| 邮件正文超 token 限制 | AI 调用失败 | 截断 + 提示词要求"先看 subject / from" |
| 用户邮箱量很大（>10k） | 拉取慢 | MVP 限制 IDB 保留数量；按 `by-receivedAt` 滚动 |
| Gmail OAuth 复杂度高 | M1/M2 拖期 | MVP 用 IMAP + 邮箱密码；OAuth 后置 |
| IndexedDB 在 SW 中被回收 | 心跳首次跑慢 | 用 `openDb()` 单例懒开 + `onversionchange` 让路 |
| 凭证明文 | 隐私泄露 | Settings 加"清空所有数据"按钮 + 隐私声明卡片（M3+ 加口令保护） |
| UIDVALIDITY 变化 | 邮箱重建 → 历史游标失效 | 检测到就清零 + 警告用户；不试图"恢复"（无 ID 可靠恢复） |
| 极简 / 完整模式 UI 两套 | UI 实现成本 | 抽公共组件（MailListItem / EmptyState）；Popup 顶层按 mode 分发 |

---

## 后续读什么

- 邮箱连接：[`features/01-mail-inbox-connect.md`](./features/01-mail-inbox-connect.md)
- AI 总结（多 Provider）：[`features/02-ai-summary.md`](./features/02-ai-summary.md)
- 验证码：[`features/05-verification-code.md`](./features/05-verification-code.md)
- 存储 schema：[`design/storage.md`](./design/storage.md)
- 极简模式：[`design/minimal-mode.md`](./design/minimal-mode.md)