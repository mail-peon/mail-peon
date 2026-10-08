# mail-peon

> 在你的浏览器里放一个常驻的「邮件 + AI 助理」：**重要的邮件立刻知道，验证码自动复制，剩下的全是噪音。**

一个 Manifest V3 浏览器扩展（Chrome / Firefox）。基于
[`antfu/vitesse-webext`](https://github.com/antfu/vitesse-webext) 模板。

设计文档在 [`ai-docs/`](./ai-docs/README.md)（先读那里，再读代码）。

---

## 两种运行模式

| 模式 | 给谁 | 能力 |
| --- | --- | --- |
| **极简模式**（默认） | 只关心验证码的人 | 看到含验证码的邮件 → 自动复制 → 顶部 toast。其它邮件**不入库、不展示** |
| **完整模式** | 想看邮件流的用户 | AI 总结 + 广告屏蔽 + 提示词规则 + 排除列表 + 邮件流 + Badge |

在「设置 · 通用」顶部一键切换，**切换不清数据**。

---

## 核心能力

- **验证码自动复制**：三级降级（Service Worker → 页面内容脚本 → toast 上的「点击复制」按钮），
  并在页面顶部弹一条 shadow DOM 隔离的 toast —— 不用系统通知，不抢焦点。
- **本地优先**：账号、规则、邮件全部存在本机 IndexedDB。极简模式下**邮件正文根本不存**，
  只留验证码和头部。任何发给 AI 的内容都只在你配置的平台之间流动。
- **多 AI 平台**：OpenAI / DeepSeek / Anthropic / 任意 OpenAI 兼容服务。AI 输出经 zod 校验，
  失败自动降级（仍能看到邮件的基础信息）。
- **多提示词规则**：按发件人邮箱 / 域名 / 正则匹配专属提示词，可拖拽排序（priority 越小越优先）。
- **增量同步**：**首次连上只记同步位置，不拉任何历史邮件**；之后按游标拉增量。
  邮箱被重建（UIDVALIDITY 变化）时清零游标并明确警告，不试图「恢复」。

---

## 快速开始

```bash
pnpm i
pnpm build          # 或 pnpm dev 开发
```

然后在浏览器里加载 **`extension/`** 目录（`chrome://extensions` → 开发者模式 → 加载已解压的扩展程序）。

### 1. 接一个邮箱

扩展支持两种协议，**性质差别很大**：

| 协议 | 需要什么 | 能收到真邮件吗 |
| --- | --- | --- |
| **Gmail（OAuth）** | 一个 Google Cloud OAuth 客户端（类型选「Chrome 扩展」） | ✅ 开箱即用 |
| **IMAP** | 一个 WebSocket↔TCP 中继 | ✅ 但要自己起中继 |

> **为什么 IMAP 需要中继**：浏览器扩展里**没有裸 TCP**。MV3 的 Service Worker 只有
> `fetch` / `WebSocket`，`chrome.sockets.tcp` 只属于已废弃的 Chrome Apps。详见
> [`ai-docs/decisions/adr-0005-imap-needs-relay.md`](./ai-docs/decisions/adr-0005-imap-needs-relay.md)。

中继实现随仓库提供（**纯字节透传，看不到明文** —— TLS 是端到端建立的）：

```bash
pnpm relay                                     # ws://127.0.0.1:8787/
PORT=9000 RELAY_TOKEN=xxx ALLOWED_HOSTS=imap.example.com pnpm relay
```

然后在「设置 · 账号」里把中继地址填成 `ws://127.0.0.1:8787/`，再填 IMAP 服务器 / 用户名 / 密码。

### 2. 配一个 AI Key

「设置 · AI 配置」→ 选平台 → 填 API Key → 点「测试连通」。

极简模式的验证码提取**也需要 AI**（它用一句极短的提示词把验证码从邮件里抠出来，
输入 <200 token / 输出 <30 token，几乎免费）。没配 Key 时弹窗顶部会有提示。

### 3. 完成

心跳每 5 分钟跑一次。也可以在「设置 · 通用」点「立即同步增量」手动触发。

---

## 开发

```bash
pnpm dev            # 开发（Vite HMR + 自动重建）
pnpm dev-firefox    # Firefox
pnpm build          # 生产构建
pnpm lint           # ESLint
pnpm typecheck      # tsc --noEmit
pnpm test           # Vitest（210 个用例）
pnpm relay:test     # IMAP 中继的端到端冒烟测试
pnpm pack:zip       # 打包上架用
```

**提交门槛**：`pnpm lint && pnpm typecheck && pnpm test && pnpm build` 全绿。

### 目录结构

```
src/
├── adapters/            适配器层（可插拔，注册表按目录 glob）
│   ├── collect.ts       「按目录约定收集适配器」的共用实现
│   ├── mail/            邮箱协议
│   │   ├── types.ts     MailProvider / MailConnection / RawMail 抽象
│   │   ├── registry.ts  注册表 —— 加 provider 不用改它
│   │   ├── mailbox.ts   同步编排（首次只记游标 / 增量 / 排除邮箱）
│   │   ├── parser.ts    RFC822 → Mail（IMAP 与 Gmail 共用）
│   │   ├── transport/   ★ MailSocket 抽象 + WebSocket↔TCP 中继实现
│   │   └── providers/
│   │       ├── gmail/   OAuth + Gmail REST API
│   │       └── imap/    自研 IMAP4rev1 客户端（只覆盖必需命令）
│   └── ai/              AI 平台（protocol 管 wire 格式，platform 管声明）
│       ├── protocols/   openai.ts / anthropic.ts / chat.ts（共用脚手架）
│       └── platforms/   openai / deepseek / anthropic / custom
├── platform/            环境相关通用件
│   ├── idb/             ★ IndexedDB 封装（database.ts / schema.ts）
│   └── http.ts          带超时的 fetch
├── logic/               业务逻辑（**不 import 任何 chrome.* API**）
│   ├── types.ts         领域模型 + 默认值（跨上下文共享）
│   ├── strings.ts       集中文案（i18n 钩子）
│   ├── messaging.ts     webext-bridge 通道封装
│   ├── bridge.ts        UI 侧的数据访问层（所有 UI 都经它问 background 要数据）
│   ├── store/           仓库门面：accounts / rules / mails / settings
│   │   ├── ready.ts     ★ 初始化门闸 + withReady 包装
│   │   ├── prune.ts     滚动淘汰（单独一个模块以打断循环依赖）
│   │   ├── migrations.ts 纯归一化函数
│   │   └── legacy.ts    chrome.storage.local → IDB 的一次性迁移
│   ├── rules/           规则匹配 + 排除邮箱
│   ├── ai/              流水线 / 提示词 / zod 校验 / 降级 / 并发闸门
│   └── notification/    Notifier 接口 + badge + 文案
├── background/          心跳（alarms）+ 消息处理 + Notifier 实现
├── contentScripts/      页面顶部 toast（closed shadow DOM）+ 剪贴板
├── popup/ sidepanel/ options/   三个界面（两套布局按 minimalMode 分发）
└── components/          跨界面共享的 Vue 组件
```

★ = 最容易踩坑的几处，改之前先读文件头的说明。

### 三条硬规矩

1. **AI 调用 / 邮件解析 / HTTP 全在 background**。UI 只渲染 + 收发消息，
   content script 只负责「在用户当前页面反馈」。所以 `logic/` 里
   **不允许出现 `chrome.*`**（副作用都收在 `logic/notification/types.ts` 的
   `Notifier` 接口后面，单测塞 `noopNotifier`）。
2. **事务里不准 `await` 非本事务的 IDB 操作**。IndexedDB 的事务在控制权交回事件循环时
   自动提交，所以「在事务里读设置」会让外层事务失活。见 `platform/idb/database.ts` 头部。
3. **门闸内部不准调用套了 `withReady` 的函数**（会死锁 —— 等自己）。
   见 `logic/store/ready.ts` 头部。

---

## 隐私

- 账号凭据（IMAP 密码 / OAuth token / AI Key）**明文存在本机 IndexedDB**，
  不上传任何服务器。「设置 · 通用」里有「清空所有数据」按钮。
- 只有调用 AI 时，才会把**主题 + 正文片段**发到你配置的 AI 平台。
- 极简模式下邮件正文**根本不存储**，只留验证码和头部。
- IMAP 中继是纯字节透传：TLS 在扩展与邮件服务器之间端到端建立，
  中继读不懂流量、不落盘、不解析 IMAP。

---

## 致谢

模板来自 [`antfu/vitesse-webext`](https://github.com/antfu/vitesse-webext)；
架构思路（IndexedDB 封装、适配器注册表、平台/协议分层）参考同作者的
`offer-hunter`。
