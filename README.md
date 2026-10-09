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
  邮件里写了有效期时还会显示**倒计时进度条**（由 AI 读时长，不靠正则猜）。
- **回收站**：删除是**可恢复**的（只是标记），彻底删除才真的从记录里移除。
  失效验证码默认在失效 30 秒后自动进回收站 —— 手滑删错、或想再看一眼，都还来得及。
- **本地优先**：账号、规则、邮件全部存在本机 IndexedDB。极简模式下**邮件正文根本不存**，
  只留验证码和头部。任何发给 AI 的内容都只在你配置的平台之间流动。
- **多 AI 平台**：OpenAI / DeepSeek / Anthropic / 任意 OpenAI 兼容服务。AI 输出经 zod 校验，
  **完整模式**下失败自动降级（仍能看到邮件的基础信息）；极简模式没有降级 ——
  拿不到验证码就丢弃该邮件。
- **多提示词规则**：按发件人邮箱 / 域名 / 正则匹配专属提示词，可拖拽排序（priority 越小越优先）。
- **增量同步**：**首次连上只记同步位置，不拉任何历史邮件**；之后按游标一批批拉（每批 ≤50 封）。
  邮箱被重建（UIDVALIDITY 变化）时把游标重置到最新并明确警告，不试图「恢复」。

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

中继实现随仓库提供：

```bash
pnpm relay                                     # 默认 ws://127.0.0.1:8787/
pnpm relay --port 9000 --token xxx --allow-hosts imap.example.com
```

> ⚠️ **中继能看到明文，包括邮箱密码。** 这是 TLS 语义决定的，不是缺陷：
> 常驻监听用的是 implicit TLS（993），中继必须自己终结 TLS 才能说 IMAP ——
> 所以它手里有一份解密后的字节流。默认只绑 `127.0.0.1`，以及 `--token` 的存在，
> 都是因为这个。详见 [`adr-0005`](./ai-docs/decisions/adr-0005-imap-needs-relay.md)。

然后在「设置 · 账号」里把中继地址填成 `ws://127.0.0.1:8787/`，再填 IMAP 服务器 / 用户名 / 密码。

### 2. 配一个 AI Key

「设置 · AI 配置」→ 选平台 → 填 API Key → 点「测试连通」。

极简模式的验证码提取**也需要 AI**（它用一句极短的提示词把验证码从邮件里抠出来，
输入 <200 token / 输出 <30 token，几乎免费）。没配 Key 时弹窗顶部会有提示。

### 3. 完成

兜底心跳每 **10 分钟**跑一次（`SYNC_PERIOD_MINUTES`）；正常收信靠中继推送，不靠它。
也可以在「设置 · 通用」点「立即同步增量」手动触发。

---

## 开发

```bash
pnpm dev            # 开发（Vite HMR + 自动重建）
pnpm dev-firefox    # Firefox
pnpm build          # 生产构建
pnpm lint           # ESLint
pnpm typecheck      # tsc --noEmit + 脚本的类型检查（tsconfig.scripts.json）
pnpm test           # Vitest（单元 / 组件测试）
pnpm relay:test     # IMAP 中继的端到端冒烟测试
pnpm pack:zip       # 打包上架用
```

`scripts/` 下的运维脚本（含中继本体）是 **TypeScript**，由
[`esno`](https://github.com/esbuild-kit/esno) 执行（`pnpm relay` 等已经包好，不用自己敲）。
⚠️ 它们**不能用顶层 `await`** —— 根 `package.json` 没有 `type: "module"`，
所以 `.ts` 会被编成 CommonJS，入口逻辑要包在 `async function main()` 里。
原因与两个被否决的替代方案见
[`relay-deployment.md`](./ai-docs/decisions/relay-deployment.md)。

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
- IMAP 中继**不落盘、不解析邮件内容**，但 ⚠️ **它能读到明文** ——
  常驻监听模式下中继自己终结 TLS（要读 `EXISTS` 才知道有没有新邮件），
  所以它手里有解密后的字节流，**包括邮箱密码**。
  它默认只绑 `127.0.0.1`、是你自己跑的一个进程，不是一个我们运营的服务；
  但**不要把它暴露到公网**。详见
  [`adr-0005`](./ai-docs/decisions/adr-0005-imap-needs-relay.md)。

---

## 致谢

模板来自 [`antfu/vitesse-webext`](https://github.com/antfu/vitesse-webext)；
架构思路（IndexedDB 封装、适配器注册表、平台/协议分层）参考同作者的
`offer-hunter`。
