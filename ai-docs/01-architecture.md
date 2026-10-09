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

用 [`webext-bridge`](https://github.com/serversideup/webext-bridge)。

> **通道清单的单一真相是 [`shim.d.ts`](../shim.d.ts) 里的 `ProtocolMap`** ——
> 它同时充当类型声明与文档，`send` / `onMessage` 靠它保证拼写正确。
> 这里**不再维护一份副本**：早期那张表只有十几个通道，实际有 40 多个，
> 而且 `mail:new` / `settings:set` 这种**不存在**的通道还留在表里。

按用途分组（细节看 `ProtocolMap`）：

| 组 | 通道 |
| --- | --- |
| 邮件 | `mail:list`、`mail:get`、`mail:dismiss`、`mail:mark-all-read`、`mail:updated`（广播） |
| 验证码复制 | `mail:copy-code`（bg → content script 的重试通道）、`mail:manual-copy-result`、`mail:toast` |
| 账号与同步 | `accounts:list` / `upsert` / `delete` / `test` / `reset-cursor` / `gmail-authorize`、`accounts:sync-now`、`accounts:sync-status`、`sync:done`（广播） |
| 回收站 | `trash:list` / `trash` / `restore` / `delete` / `empty` |
| 规则 | `rules:list` / `upsert` / `delete` / `move` |
| 设置 | `settings:get`、`settings:set-app`、`settings:set-ai`、`settings:usage`、`settings:clear-mails`、`settings:clear-all` |
| AI / Provider | `ai:platforms`、`ai:test`、`mail:providers` |
| 通用广播 | `data:changed`（「别处数据变了，去重读」） |

> **不再使用 `chrome.notifications`**，新邮件到达只用 `chrome.action.setBadgeText` 提示，详细见 [`features/02-ai-summary.md § 6`](./features/02-ai-summary.md)。

几个容易踩的点：

- **广播不保证送达**。`webext-bridge` 的 `connMap` 每个 context 名只留最后一个连接，
  而三个界面（Popup / Options / Sidepanel）**都注册成 `popup`** ——
  一个断开就把整个键删掉。所以「点同步」这类操作必须**同时**提供轮询兜底
  （`accounts:sync-status`），不能只靠 `sync:done`。详见
  [`decisions/imap-testing.md § 11`](./decisions/imap-testing.md)。
- **`accounts:sync-now` 立刻返回、不等结果**：MV3 的 SW 空闲 30 秒被回收，
  而「正在进行中的 `sendMessage`」**不算事件** —— 把一轮同步的耗时压在消息往返上，
  超过 30 秒时 promise 永远不 settle（真机现象：一直停在「同步中」）。

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
| 隐私声明 | privacy policy | ⬜ `data_collection_permissions.required = ['none']` **尚未加进 manifest** —— AMO 上架时补 |

**权限**（`manifest.ts` 的 `permissions`）：`tabs`、`activeTab`、`alarms`、
`sidePanel`、`identity`（Gmail OAuth）、`storage`（仅一次性迁移的兼容读取）。
**刻意没有 `scripting`** —— content script 是常驻注入的（见 `design/page-toast.md`）。

---

## 6. 生命周期关键点

- **MV3 Service Worker 会休眠**（空闲约 30 秒被回收）：所以**不把长连接放在插件里**。
  常驻 IMAP `IDLE` 由中继持有（§ 1.1），插件只在被推醒时做「单次连接抓增量」。
- **插件保留一个低频 `alarms` 兜底**：推送依赖「中继在跑 + 连接活着」，两个前提都可能
  不成立（中继没起、睡眠后连接没恢复）。它是保险丝，不是主要手段。
- **冷启动**：监听 `runtime.onInstalled` / `runtime.onStartup`，恢复中继 watch 连接与兜底定时器。
- **onMessage**：每个 handler 的第一步都是 `await ensureStoreReady()` ——
  SW 冷启动时 IDB 迁移可能还没跑完。**不要**写 `dataReady`（那是
  `useWebExtensionStorage` 时代的东西，已不再使用）。

---

## 7. 安全原则

1. **凭证最小化**：邮箱密码 / OAuth refresh token / AI Key **明文存在本机
   IndexedDB**（加密待议：没有「既方便又安全」的密钥来源）。「设置 · 通用」里
   有「清空所有数据」按钮。
2. **邮件正文会发给 AI**：调用 AI 时发送 `subject` + `from` + `date` +
   `List-Unsubscribe` + **正文前 6000 字**（`MAX_BODY_CHARS`，截断处标注）。
   不发送附件，HTML 不入库。
   > ⚠️ 早期文档写的是「不上传邮件正文」——**那是错的**，AI 总结必须看到正文。
3. **IMAP 需要中继**，而中继**能看到明文**（包括密码）—— 它自己终结 TLS。
   默认只绑 `127.0.0.1`，且是用户自己跑的进程。见 [`adr-0005`](./decisions/adr-0005-imap-needs-relay.md)。
4. **白盒提示词**：所有提示词用户可见、可改、可导入 / 导出。
5. **网络白名单**：仅允许访问用户配置的 `AI BaseURL`、邮箱 host、以及中继地址。

---

## 8. 后续读什么

- 技术栈：[`02-tech-stack.md`](./02-tech-stack.md)
- 路线图：[`03-roadmap.md`](./03-roadmap.md)
- 数据模型：[`design/data-model.md`](./design/data-model.md)
- 页面顶部 toast：[`design/page-toast.md`](./design/page-toast.md)