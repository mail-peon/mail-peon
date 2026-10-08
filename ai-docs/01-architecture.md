# 01 · 架构

> 本文档讲清楚 mail-peon 这个 MV3 扩展在浏览器里是怎么跑起来的、谁负责什么、彼此怎么通信。读完应当能直接动手改源码。

---

## 1. MV3 运行时拓扑

```
┌──────────────────────────────────────────────────────────┐
│                       Browser                             │
│                                                          │
│   ┌──────────────┐     webext-bridge    ┌────────────┐    │
│   │  Background   │◄──────────────────►│  Popup     │    │
│   │  Service      │                    │            │    │
│   │  Worker       │                    └────────────┘    │
│   │               │                                        │
│   │  • 邮箱连接    │     webext-bridge    ┌────────────┐    │
│   │  • 轮询新邮件  │◄──────────────────►│  Options   │    │
│   │  • AI 调用     │                    │  (tab)     │    │
│   │  • 写存储      │                    └────────────┘    │
│   │  • Badge 更新  │                                        │
│   │  • 推 toast    │     webext-bridge    ┌────────────┐    │
│   │               │◄──────────────────►│ Sidepanel  │    │
│   │               │                    │            │    │
│   └──────┬────────┘                    └────────────┘    │
│          │ webrender ▲                                         │
│          │ mail:toast │                                │
│          │ mail:copy-code                                │
│          ▼ mail:toast │                                │
│   ┌──────────────┐     ┌────────────────────────┐       │
│   │  Storage     │     │  Content Script        │       │
│   │  (本地)       │     │  (每个页面 1 个实例)     │
│   │  useWebExt…  │     │  • 渲染顶部 toast       │       │
│   │              │     │  • 在 focus 上下文复制   │       │
│   └──────────────┘     └────────────────────────┘       │
└──────────────────────────────────────────────────────────┘
```

> **不用 `chrome.notifications`**——新邮件只用 `chrome.action.setBadgeText` 提示；其它"刚做完一件事"的反馈（验证码复制）走页面顶部 toast（content script 渲染）。

<details>
<summary>中继在拓扑中的位置</summary>

```
   Background SW ──── WebSocket（本机）────┐
                                          │
                              ┌───────────▼──────────┐
                              │  中继（本机 Node 进程） │
                              │  • 常驻 IMAP IDLE     │
                              │  • 字节透传           │
                              └───────────┬──────────┘
                                          │ TLS 993
                              ┌───────────▼──────────┐
                              │    邮件服务器          │
                              └──────────────────────┘
```

</details>

### 1.1 为什么需要一个本机中继

浏览器扩展**没有裸 TCP**（MV3 只有 `fetch` / `WebSocket`；`chrome.sockets.tcp` 属于已废弃的 Chrome Apps），
而 IMAP 长在 TCP 上。所以浏览器要收发 IMAP，中间必须有人把 WebSocket 的字节搬进 TCP —— 这个角色就是**中继**。

中继同时承担另一件事：**持有常驻的 IMAP `IDLE` 连接**，新邮件一到就推给插件。

| 为什么长连接不能放在插件里 | |
| --- | --- |
| MV3 Service Worker 空闲约 30 秒被回收 | `setInterval` 与常驻连接都保不住 |
| 中继是普通 Node 进程 | 可以长时间挂着 `IDLE` —— 这正是「实时」的前提 |

> 中继**不需要额外信任**：它为了跟邮件服务器通 TLS，本来就要终止握手、看到明文
> （包括邮箱密码）。所以让它持有长连接不扩大信任面。
> 详细论证见 [`decisions/adr-0005-imap-needs-relay.md`](./decisions/adr-0005-imap-needs-relay.md)。

### 角色分工

| 上下文 | 职责 |
| --- | --- |
| **Background SW** | 接中继推送后抓增量、解析邮件、调用 AI、写存储、更新 Badge、推送 Toast |
| **中继** | 常驻 IMAP `IDLE`（发现新邮件）+ 字节透传（供插件抓取）。**不解析邮件内容** |
| **Popup** | 用户点了工具栏图标 → 看「最近重要邮件列表」+ AI 摘要 |
| **Sidepanel** | 展开后的完整视图（分 Tab：全部 / 重要 / 验证码 / 营销） |
| **Options** | 设置页（账号 / 提示词 / 排除 / AI 配置） |
| **Content Script** | **M2 起启用**：渲染顶部 toast（shadow DOM 隔离）+ 在页面 focus 上下文执行复制 |

> **规则：AI 调用、邮件解析、HTTP 全部放 Background。Popup/Options 只渲染 + 收发消息。Content Script 仅承担"在用户当前页面反馈"的责任（toast 渲染 + clipboard.writeText 重试）。**
>
> **规则：中继只看得到「有几封邮件」，看不到主题与正文。** 它需要解析的 IMAP 仅限于
> `LOGIN` / `SELECT` / `IDLE` 的响应行。中继越笨，它出问题时的破坏面越小。

---

## 2. 源码目录（现状 + 计划）

> 模板已存在的标记为「✅ 现状」，业务相关标记为「📦 计划」。

```
src/
├── manifest.ts                    ✅ MV3 manifest 生成器
│
├── background/                    ✅ Background SW 入口（main.ts）
│   ├── main.ts                    ✅ 收信主循环（接中继推送 / 兜底定时器 / 消息处理）
│   └── contentScriptHMR.ts        ✅ 开发期注入
│
├── popup/                         ✅ Popup 入口
│   ├── main.ts
│   ├── Popup.vue                  ✅ 模板占位；将改造为"最近邮件"
│   └── index.html
│
├── sidepanel/                     ✅ Sidepanel 入口（MV3 才有的面板）
│   ├── main.ts
│   ├── Sidepanel.vue              ✅ 模板占位；将改造为"邮件流"
│   └── index.html
│
├── options/                       ✅ Options 页（标签页打开）
│   ├── main.ts
│   ├── Options.vue                ✅ 模板占位；将改造为"设置"
│   └── index.html
│
├── contentScripts/                ✅ 内容脚本（MVP 暂不启用业务）
│   ├── index.ts                   ✅ 模板占位；M2 起承担 toast 渲染
│   ├── toast.ts                   📦 顶部 toast 渲染（shadow DOM）
│   └── views/App.vue              ✅ 模板占位
│
├── components/                    ✅ 跨上下文共享 Vue 组件
│   ├── Logo.vue
│   ├── SharedSubtitle.vue
│   ├── SecretInput.vue            📦 密码 / token 输入（参考 offer-hunter 眼睛图标组件）
│   └── README.md                  📦 这里放「邮件列表项 / 摘要卡 / 验证码徽章」
│
├── composables/                   ✅ 跨上下文共享 Composables
│   └── useWebExtensionStorage.ts  ✅ 模板自带，**MVP 不再用**（改用 IndexedDB）
│
├── platform/                      📦 平台层通用件（参考 offer-hunter/platform/）
│   ├── idb/
│   │   ├── database.ts            📦 IndexedDB 通用封装（openDb / withTx / put / iterate / runTx）
│   │   ├── schema.ts              📦 DB schema（stores + 索引 + upgrade）
│   │   └── __tests__/             📦 IDB 单测
│   ├── http.ts                    📦 带超时的 fetch
│   └── secrets/
│       └── crypto.ts              📦 M3+ 口令派生加密（MVP 空壳）
│
├── adapters/                      📦 适配器层（参考 offer-hunter/adapters/）
│   ├── mail/                      📦 邮箱协议适配器
│   │   ├── types.ts               📦 MailProvider / MailConnection 抽象
│   │   ├── registry.ts            📦 Provider 注册表（按目录约定聚合）
│   │   ├── mailbox.ts             📦 拉取 / 解析 / 入库 编排
│   │   ├── parser.ts              📦 RFC822 → Mail 归一
│   │   └── providers/             📦 各协议实现
│   │       └── imap/index.ts      📦 MVP：IMAP + 用户名密码
│   │       # ├── gmail/index.ts   📦 OAuth Gmail（可选，M3+）
│   │       # └── outlook/index.ts 📦 Outlook Graph（可选，M3+）
│   │
│   └── ai/                        📦 AI Provider 适配器（镜像 offer-hunter）
│       ├── types.ts               📦 AiProvider / AiProtocol / ResolvedConfig
│       ├── registry.ts            📦 平台注册表
│       ├── summarize.ts           📦 调 AI 生成 AiOutput
│       ├── classify.ts            📦 调 AI 判定广告 / 验证码
│       ├── prompt-build.ts        📦 组装系统提示词 + 用户规则
│       ├── protocols/             📦 wire 格式
│       │   ├── openai.ts          📦 OpenAI 兼容（DeepSeek / 各类中转）
│       │   └── anthropic.ts       📦 Anthropic
│       └── platforms/             📦 每平台一个目录
│           ├── openai/index.ts    📦 OpenAI（默认 gpt-4o-mini）
│           ├── deepseek/index.ts  📦 DeepSeek（默认 deepseek-flash，关闭思考）
│           ├── anthropic/index.ts 📦 Anthropic（claude-3-5-haiku）
│           └── custom/index.ts    📦 自定义（用户填 baseURL + key + model）
│
├── logic/                         ✅ 业务逻辑（无 Vue 的纯 TS）
│   ├── common-setup.ts            ✅ shim
│   ├── index.ts                   ✅ 公共 setup
│   ├── strings.ts                 📦 集中文案（i18n 钩子）
│   ├── types.ts                   📦 跨层共享类型
│   ├── messaging.ts               📦 webext-bridge 消息通道统一封装
│   │
│   ├── store/                     📦 IndexedDB 门面（参考 offer-hunter/logic/store/）
│   │   ├── ready.ts               📦 ensureStoreReady() 初始化门闸
│   │   ├── settings.ts            📦 单文档（app / ai）
│   │   ├── accounts.ts            📦 账号仓库（含 per-account blockedList）
│   │   ├── rules.ts               📦 PromptRule 仓库
│   │   ├── mails.ts               📦 Mail 仓库（含按 receivedAt 滚动 100）
│   │   ├── legacy.ts              📦 chrome.storage.local → IndexedDB 一次性迁移
│   │   └── migrations.ts          📦 纯归一化函数
│   │
│   ├── rules/                     📦 规则匹配
│   │   ├── matcher.ts             📦 发件人 / 域名 / 正则匹配
│   │   └── rule-engine.ts         📦 对一封邮件挑一条规则
│   │
│   └── notification/              📦 Badge + Toast 反馈（不调系统通知）
│       ├── badge.ts               📦 chrome.action.setBadgeText 包装
│       └── toast.ts               📦 "对哪个 tab 弹什么 toast"判定
│
├── assets/                        ✅ 模板资源
└── styles/                        ✅ 公共样式
```

> 📦 目录是**目标态**。MVP 阶段不必一次性建齐，按里程碑增量创建（见 [`03-roadmap.md`](./03-roadmap.md)）。

---

## 3. 跨上下文通信

模板已使用 [`webext-bridge`](https://github.com/serversideup/webext-bridge)，约定**消息命名**如下：

| Channel | 方向 | 用途 |
| --- | --- | --- |
| `mail:new` | bg → popup/sidepanel | 新邮件到达 |
| `mail:updated` | bg → popup/sidepanel | 邮件 AI 处理完成 |
| `mail:list` | popup/sidepanel → bg | 取最近邮件列表 |
| `mail:get` | popup/sidepanel → bg | 取单封邮件 + 摘要 |
| `mail:copy-code` | bg → content_script | 验证码重试复制（在页面 focus 上下文里执行 writeText） |
| `mail:toast` | bg → content_script | 在当前页面顶部弹 toast（详见 [`design/page-toast.md`](./design/page-toast.md)） |
| `mail:dismiss` | popup/sidepanel → bg | 标记为已读 / 删除 |
| `accounts:list` | options → bg | 取所有邮箱账号 |
| `accounts:upsert` | options → bg | 新增 / 修改账号 |
| `accounts:test` | options → bg | 测试连接 |
| `accounts:delete` | options → bg | 删除账号 |
| `rules:list` | options → bg | 取所有 PromptRule |
| `rules:upsert` | options → bg | 增改规则 |
| `rules:delete` | options → bg | 删除规则 |
| `settings:get` / `settings:set` | options/popup → bg | 全局设置 |
| `ai:test` | options → bg | 测试 AI 配置 |

> **不再使用 `chrome.notifications`**，新邮件到达只用 `chrome.action.setBadgeText` 提示，详细见 [`features/02-ai-summary.md § 6`](./features/02-ai-summary.md)。

消息体使用 TypeScript 类型（建议放在 `src/logic/types.ts`），并通过 `shim.d.ts` 给 `OnMessageEventNameMap` 加签名。

---

## 4. 存储

**所有持久化都用 IndexedDB**（与 [`offer-hunter/src/platform/idb/`](https://github.com/) 一致），不用 `chrome.storage.local`。

- **DB 名**：`mail-peon`
- **当前 version**：`1`（每次结构性变更必须 +1，并在 `upgrade()` 追加分支）
- **仓库**：
  - `accounts` — 邮箱账号（外部键 `accountId`）
  - `rules` — PromptRule（外部键 `ruleId`）
  - `mails` — 邮件（外部键 `<accountId>:<messageId>`，带 `by-accountId` / `by-receivedAt` 索引）
  - `settings` — 单文档设置（内部键 `id`：`app` / `ai`）
  - `meta` — 迁移标记（内部键 `key`）

完整 schema 见 [`design/storage.md`](./design/storage.md)；字段定义见 [`design/data-model.md`](./design/data-model.md)。

> **适配器模式**：读写走 `src/platform/idb/` 下的通用原语（`get / put / iterate / runTx` 等），不要在业务代码里直接 `indexedDB.open`。

---

---

## 5. 权限（manifest）

参考 `D:\Projects\offer-hunter\src\manifest.ts`。MVP 阶段 `manifest.ts` 需要：

| 权限 | 用途 |
| --- | --- |
| `tabs` | 查激活 tab（toast 投递） |
| `activeTab` | 当前 tab 短时访问 |
| `alarms` | 兜底定时抓取（推送失效时的保险丝） |
| `sidePanel` | Chrome 侧边栏（MVP 可选） |
| `storage` | **仅用于一次性迁移**（从 chrome.storage.local 迁到 IndexedDB，迁移完成后摘除） |

**不要**：

| ~~权限~~ | 否决原因 |
| --- | --- |
| ~~`notifications`~~ | 改用 Badge + 页面 Toast（详见 [`features/02-ai-summary.md § 6`](./features/02-ai-summary.md)） |
| ~~`clipboardWrite`~~ | 验证码复制走 `navigator.clipboard.writeText`（SW / content_script 在用户激活态下调用） |
| ~~`unlimitedStorage`~~ | IndexedDB 默认配额远大于旧 storage（10MB），暂时不申请；用户量大再补 |
| ~~`scripting`~~ | MVP 阶段 toast 用常驻 content_script 注入；如果上架审查受阻再切按需注入 |

> **`host_permissions`**：
> - M1 / M2：保留 `<!-- <all_urls> -->` —— 仅为了让模板默认 content_script 能注入所有页面、渲染顶部 toast
> - 邮箱 IMAP host（`wss://` / `imap://`）MV3 SW 走原生 `fetch` 不需要声明 host_permissions（fetch 不需要 match pattern）
> - CRX Store 上架审查时 `<!-- <all_urls> -->` 会是审查点；M3 上架前可考虑收窄（详见 [`decisions/open-questions.md` Q15](./decisions/open-questions.md)）

### 5.1 浏览器差异

参考 `offer-hunter/src/manifest.ts`：

| | Chrome | Firefox |
| --- | --- | --- |
| 后台 | `service_worker: 'dist/background/index.mjs'` | `scripts: ['dist/background/index.mjs'], type: 'module'`（互斥给键，不要并存） |
| 侧栏 | `side_panel.default_path` | `sidebar_action.default_panel` |
| 最低版本 | MV3 | `browser_specific_settings.gecko.strict_min_version = '109.0'` |
| 隐私声明 | privacy policy | `data_collection_permissions.required = ['none']` |

---

## 6. 生命周期关键点

- **MV3 Service Worker 会休眠**（空闲约 30 秒被回收）：所以**不把长连接放在插件里**。
  常驻 IMAP `IDLE` 由中继持有（§ 1.1），插件只在被推醒时做「单次连接抓增量」。
- **插件保留一个低频 `alarms` 兜底**：推送依赖「中继在跑 + 连接活着」，两个前提都可能
  不成立（中继没起、睡眠后连接没恢复）。它是保险丝，不是主要手段。
- **冷启动**：监听 `runtime.onInstalled` / `runtime.onStartup`，恢复中继 watch 连接与兜底定时器。
- **onMessage**：Background 收消息时若 SW 刚启动，要先 `await dataReady`（基于 `useWebExtensionStorage` 的 `dataReady`）再做处理。

---

## 7. 安全原则

1. **凭证最小化**：邮箱密码 / OAuth refresh token 写到 `storage.local`（加密待议）。MVP 明文 + 文档说明。
2. **不上传邮件正文**：仅在调用 AI 时把**摘要用片段**（subject + 前 N 字）发到用户指定的 AI provider。
3. **白盒提示词**：所有提示词用户可见、可改、可导入 / 导出。
4. **网络白名单**：仅允许访问用户配置的 `AI BaseURL` 和邮箱 host。

---

## 8. 后续读什么

- 技术栈：[`02-tech-stack.md`](./02-tech-stack.md)
- 路线图：[`03-roadmap.md`](./03-roadmap.md)
- 数据模型：[`design/data-model.md`](./design/data-model.md)
- 页面顶部 toast：[`design/page-toast.md`](./design/page-toast.md)