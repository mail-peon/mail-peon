# Mail Peon — 开发文档

> 这是 `mail-peon` 浏览器插件（基于 `vitesse-webext` 模板）的开发文档目录。
> 文档面向 **AI 协作 + 开发者**，每篇尽量做到「看完即可着手开发」。

---

## 目录

### 项目层

| 文件 | 说明 |
| --- | --- |
| [00-overview.md](./00-overview.md) | 产品定位、目标用户、核心价值、非目标 |
| [01-architecture.md](./01-architecture.md) | MV3 运行时拓扑、源码目录、跨上下文通信 |
| [02-tech-stack.md](./02-tech-stack.md) | 模板技术栈 + 待新增依赖 |
| [03-roadmap.md](./03-roadmap.md) | 功能分阶段、里程碑、验收标准 |

### 功能模块（`features/`）

| # | 文件 | 说明 |
| --- | --- | --- |
| 1 | [01-mail-inbox-connect.md](./features/01-mail-inbox-connect.md) | 邮箱连接 & 新邮件监听 |
| 2 | [02-ai-summary.md](./features/02-ai-summary.md) | AI 总结 + 弹窗提醒 |
| 3 | [03-prompt-rules.md](./features/03-prompt-rules.md) | 多提示词 + 收件邮箱匹配 |
| 4 | [04-exclude-ads.md](./features/04-exclude-ads.md) | 排除广告 / 营销邮件 |
| 5 | [05-verification-code.md](./features/05-verification-code.md) | 验证码自动复制 |
| 6 | [06-blocked-senders.md](./features/06-blocked-senders.md) | 排除邮箱（本地） |
| 7 | [07-trash.md](./features/07-trash.md) | 回收站（状态变更 vs 硬删除、失效验证码自动删除） |

### 设计（`design/`）

| 文件 | 说明 |
| --- | --- |
| [storage.md](./design/storage.md) | IndexedDB schema、迁移、初始化门闸、保留数量配置、UID 增量同步 |
| [sync-flow.md](./design/sync-flow.md) | **收信流程图**（字符图：中继 IDLE 推送 / 一轮同步内部 / 积压消化 / 「同步中」如何结束） |
| [data-model.md](./design/data-model.md) | 字段定义（MailAccount / PromptRule / Mail / Settings） |
| [minimal-mode.md](./design/minimal-mode.md) | **极简模式设计**（默认 / 仅验证码自动复制） |
| [ai-prompt-design.md](./design/ai-prompt-design.md) | AI 系统提示词设计、输出 Schema、多 Provider 适配 |
| [ui-flows.md](./design/ui-flows.md) | 弹窗、Options、通知的 UI 流（含极简 / 完整两套） |
| [page-toast.md](./design/page-toast.md) | 页面顶部 Toast 设计（替代系统通知） |

### 决策（`decisions/`）

| 文件 | 说明 |
| --- | --- |
| [open-questions.md](./decisions/open-questions.md) | 待决策项（IMAP vs OAuth 等） |
| [adr-0005-imap-needs-relay.md](./decisions/adr-0005-imap-needs-relay.md) | **IMAP 在 MV3 里必须经 WebSocket↔TCP 中继**（推翻 Q1 的「IMAP+密码直接可用」） |
| [relay-deployment.md](./decisions/relay-deployment.md) | **中继的部署方案**：用户级自启 + Rust 单安装器（安装/卸载两个选项）；为什么「零额外安装」做不到 |
| [imap-testing.md](./decisions/imap-testing.md) | **IMAP 验收指南（QQ 邮箱）**：QQ 侧授权码怎么拿、扩展怎么填、六条验收清单、故障定位表 |
| [debugging-receiving.md](./decisions/debugging-receiving.md) | **排查：收到推送但界面没邮件** —— 两处控制台怎么开、日志断点对照表 |
| [release-pipeline.md](./decisions/release-pipeline.md) | **发版流水线**：`pnpm release` → tag → CI 自动构建/打包/建 Release/发 Chrome Web Store；五个凭据从哪来、怎么填 |

---

## 阅读顺序建议

1. 新人 / AI 协作者：[`00-overview.md`](./00-overview.md) → [`01-architecture.md`](./01-architecture.md) → [`02-tech-stack.md`](./02-tech-stack.md)
2. 着手开发某功能：先看 [`03-roadmap.md`](./03-roadmap.md) 找对应阶段，再读对应 `features/*.md`
3. 写代码前：查 [`design/data-model.md`](./design/data-model.md) 确认数据结构
4. 改提示词：参考 [`design/ai-prompt-design.md`](./design/ai-prompt-design.md)
5. 卡在选型 / 方案上：翻 [`decisions/open-questions.md`](./decisions/open-questions.md)

---

## 命名约定

- 文件名：`kebab-case.md`，放在正确子目录下
- 文档内代码块用 `ts` / `vue` / `bash` / `json` 标注语言
- 数据模型字段命名与 `design/data-model.md` 一致，不在功能文档中私自重命名
- 每篇功能文档尽量包含：**目标 / 数据 / 处理流程 / 边界 & 异常 / 验收**

---

## 当前状态

> 最近更新：M1 + M2 功能代码落地，M3 / M4 的 UI 与交互也已接上。

- 仓库基于 [`antfu/vitesse-webext`](https://github.com/antfu/vitesse-webext) 模板。
- **已完成（有单测覆盖）**
  - 存储层：IndexedDB 五仓库 + 初始化门闸 + 滚动淘汰（`pnpm test` 210 个用例）
  - `MailProvider` 适配器 + 注册表（按目录 glob，加 provider 不改注册表）
  - 邮箱同步编排：首次只记游标、UID 增量、UIDVALIDITY 变化处理、per-account 排除邮箱
  - Gmail provider（OAuth + REST，**装上就能收真邮件**）
  - IMAP provider + 自研协议客户端 + WebSocket↔TCP 中继（`pnpm relay`）
  - AI 层：4 家平台（OpenAI / DeepSeek / Anthropic / 自定义）+ zod 校验 + 降级
  - 极简 / 完整两套流水线（预筛、验证码提取与自动复制、规则匹配、广告判定）
  - 页面顶部 toast（closed shadow DOM）+ icon badge
  - Popup / Sidepanel / Options（6 个子页）两套布局
- **约定**
  - 验证门槛：`pnpm lint && pnpm typecheck && pnpm test && pnpm build` 全绿
  - 每完成一项功能，回来勾掉 `03-roadmap.md` 里对应的验收项

### 当前卡在哪（下一步做什么）

**中继已修好，等真邮箱验收**（步骤 1、2 完成）。落地顺序见
[`decisions/relay-deployment.md § 5`](./decisions/relay-deployment.md)：

| # | 步骤 | 状态 |
| --- | --- | --- |
| 1 | 修 Node 中继的 `tls`（原先连不上 993） | ✅ |
| 2 | 修背压 / `ALLOWED_HOSTS` 通配 / **关闭帧崩溃** | ✅ |
| 3 | 用真邮箱（QQ 邮箱）验收协议 → [`imap-testing.md`](./decisions/imap-testing.md) | ⬜ **当前阶段** |
| 4 | 照抄成 Rust（有参照实现后是机械工作） | ⬜ |
| 5 | 安装器 + 服务注册 + 三平台打包 | ⬜ |
| 6 | 代码签名 / notarize | ⬜ |

自测中继本身（不需要真邮箱）：`pnpm relay:test` → 9 条断言应全绿。

> **Gmail 那条路不受影响**：纯 HTTPS REST，现在就能用。
> 想先跑通产品流程，用 Gmail 即可绕过中继。

### 与文档不一致的地方（已在 ADR 里记录）

1. **IMAP 需要中继**（[adr-0005](./decisions/adr-0005-imap-needs-relay.md)）。
   `chrome.sockets.tcp` 只属于已废弃的 Chrome Apps，扩展拿不到裸 TCP，
   而 `imapflow` / `emailjs-imap-client` 绑死 Node 的 `net` —— 所以自研了一个只覆盖
   必需命令的 IMAP 客户端，把传输抽成 `MailSocket`，中继实现随仓库提供。
2. **增量游标不叫 `lastSeenUid`**，而是 `MailAccount.cursor`（provider 自定形状）。
   因为 Gmail 的游标是 `historyId: string`，把 IMAP 的 UID 写死进编排层会让
   加第二个 provider 必须改 `syncAccount`。
3. **MIME 解析用 `postal-mime` 而不是 `mailparser`**：后者依赖 Node 的
   `stream` / `Buffer` / `iconv-lite`，打进 SW 要拖一堆 polyfill。
4. Gmail 走 `format=raw` 拿完整原文，于是 IMAP 与 Gmail 共用**同一个**
   「原始 RFC822 → Mail」解析器。
