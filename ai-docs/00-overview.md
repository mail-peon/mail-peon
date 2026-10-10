# 00 · 项目总览

> 一句话（对外文案，与 `package.json#description` 一致）：AI mail assistant in your browser that surfaces the mail that matters and auto-copies verification codes
> 中文：浏览器里的邮件助理，AI 挑出真正重要的邮件，验证码自动复制

> 名字：**Mail Peon** = 产品名（manifest `name` / 界面标题 / 工具栏提示语）；**mail-peon** = 项目名（`package.json#name` / 仓库 / IndexedDB 库名 / 日志前缀）。

---

## 1. 产品定位

`mail-peon` 是一个 **Manifest V3** 浏览器扩展，定位是「**轻量邮箱工具**」，而不是「邮件客户端」。

**同时支持 Chrome（MV3 service_worker）与 Firefox（MV3 + scripts）**，参考 [`offer-hunter/src/manifest.ts`](https://github.com/) 的多端分支。

提供**两种运行模式**，用户开关切换（不是阶段性升级，是平行选项）：

| 模式 | 给谁 | 能力 |
| --- | --- | --- |
| **极简模式** | 只关心验证码的用户 | 只做一件事：看到含验证码的邮件 → 自动复制 → 顶部 toast；其它邮件直接丢弃，不入库、不展示 |
| **完整模式** | 想看邮件流的用户 | 全部能力：AI 总结 + 广告屏蔽 + 提示词 + 排除列表 + 邮件流展示 + Badge |

**MVP 同时发布两种模式**，用户根据需要二选一（可在设置里切换）。MVP 不卖"先用极简，以后再升级"。

参考：[offer-hunter](./README.md)（同作者已上线的产品，模式类似：抓取信息 → AI 处理 → 弹窗 / 总结）。

---

## 2. 核心价值

| 痛点 | 解法 |
| --- | --- |
| 邮箱淹没在广告里，找不到重要邮件 | 弹窗只展示重要邮件；营销邮件静默 |
| 验证码要去邮箱翻、找到再复制 | 自动从邮件中提取并复制到剪贴板，并显示**还剩多久失效** |
| 长邮件没空看 | AI 给一段中文摘要，3 秒知道要不要点开 |
| 不同来源的邮件关心点不一样 | 给每个发件人邮箱 / 域名配置专属提示词 |
| 验证码过期了还堆在列表里 | 失效后自动清走，但**进回收站而不是直接删** —— 想找回还来得及 |

---

## 3. 目标用户

- 经常在浏览器里工作、邮箱是工作工具的人群（开发 / 运营 / 自媒体 / 客服）
- 注册了多个不同用途的邮箱（个人 / 工作 / 各平台通知），希望分流处理
- 对 AI 自动化敏感、不希望被无关邮件打扰的人

**两种模式对应两类用户：**
- **极简模式用户**：经常要输验证码、又懒得手动去邮箱翻；只想"贴上就用"
- **完整模式用户**：想看邮件流、想 AI 总结、不想被广告骚扰；需要"少而精"的邮件信息

> **数据层与设置页支持多账号**（`AccountsPage` 能加 / 改 / 删多个账号、逐个测连接与重置游标；
> 通用页显示「账号 · N 个」），但**弹窗 / 侧边栏的邮件列表没有按账号过滤** ——
> 它读的是全部账号的邮件。详见 [`decisions/open-questions.md` Q6](./decisions/open-questions.md)。
>
> ⚠️ 想接一个任意邮箱（IMAP）需要**先在本机跑一个中继进程** ——
> 浏览器扩展里没有裸 TCP。Gmail 走 OAuth，不需要中继。
> 见 [`decisions/adr-0005-imap-needs-relay.md`](./decisions/adr-0005-imap-needs-relay.md)。

---

## 4. 非目标（Explicit Non-Goals）

| 不做 | 原因 |
| --- | --- |
| 不替代邮箱 UI / 不支持写邮件 | 浏览器里写信体验差；用户继续用 Gmail / Outlook 写信 |
| 不做 IMAP / SMTP 发件 | 同上 |
| 不做账号同步 / 团队 / 协作 | 隐私敏感、个人工具 |
| 不在云端保存邮件正文 | 邮件属于隐私数据，只在本机 IndexedDB |
| 不做搜索 / 全文检索 | 不替代 Gmail 搜索；需要看完整邮件 → 打开邮箱 |
| 不做桌面通知 | 改用 **icon badge + 页面顶部 toast**（详见 [`design/page-toast.md`](./design/page-toast.md)） |
| MVP 不加密邮箱凭据 | "既方便又安全"的密钥来源不存在（详见 [`decisions/open-questions.md` Q2](./decisions/open-questions.md)） |

---

## 5. 用户故事（核心场景）

> 作为一名开发者，我有一个 `admin@my-domain.com`（系统通知）和一个 `me@gmail.com`（注册各平台）邮箱。
>
> 1. 我给 `admin@my-domain.com` 写了一个提示词："**如果邮件里包含验证码，直接静默复制；否则给我一行总结**"。
> 2. 我给 `github.com` 域名写了一段："**告诉我哪个仓库有新的 PR / Issue，并附链接**"。
> 3. 我把 `mailer-daemon@xxx.com` 加进"排除邮箱"，再不会看到退信通知。
> 4. 我开启了"排除广告 / 营销"，所有未接订单的推送（淘宝、Steam、什么值得买）都不会再弹窗。
>
> 我开着浏览器写代码，**只有真正需要我处理的事**才会弹窗。

---

## 6. 名词约定

| 术语 | 含义 |
| --- | --- |
| **Account** | 接入的一个邮箱账号：`provider`（`'imap'` / `'gmail'`）+ `config`（IMAP 是 host/port/tls/user/pass/**relayUrl**；Gmail 是 clientId/token）+ `cursor`（增量游标，形状由 provider 定） |
| **Mail** | 一封邮件的本地抽象（id、from、subject、body、snippet、ts） |
| **Prompt Rule** | 一条规则：匹配某个发件人 / 域名 → 用对应提示词处理 |
| **Minimal（最简）** | AI 输出的一行短总结（用于弹窗 / 系统通知） |
| **Summary（总结）** | AI 输出的多段结构化总结（展开后看） |
| **VerCode（验证码）** | 从邮件正文 / 主题中识别出的验证码字符串；可带**有效期**（`codeExpiresAt` + `codeValidForSeconds`） |
| **Ads** | 被判定为广告 / 营销的邮件 |
| **Blocked** | 在"排除邮箱"列表里的发件人，整封邮件不进入插件 |
| **Trash（回收站）** | 已「删除」但**还在库里**的邮件（写了个 `trashedAt`）。可恢复；「彻底删除」才真的移除 |

---

## 7. 边界 & 原则

- **隐私优先**：邮件正文只在本地（IndexedDB）；任何上传到 AI 提供商的文本，用户要明确知道（选项里展示 AI Provider 名）。极简模式下邮件正文**根本不存储**——只留验证码和 header。
- **可降级**：AI 调用失败时**完整模式**仍能展示邮件基础信息（标题 / 发件人 / `snippet` 前 240 字）。
  ⚠️ **极简模式没有降级** —— 它拿不到验证码就直接丢弃该邮件（不存正文、不弹 toast），因为极简模式的价值只有验证码。
- **可关闭**：每个 AI 相关开关都能关；关掉后行为退化为「无 AI 的邮件列表」。
- **i18n 钩子**：所有 UI 文案集中在 `src/logic/strings.ts`，M3+ 接 vue-i18n 或自研（一期只交付 zh-CN）。
- **AI 输出多语言**：插件 UI 中文 only，但**AI 输出语言**可在「跟随浏览器 / 跟随邮件」之间选——支持任何语言的邮件，详见 [`decisions/open-questions.md` Q17](./decisions/open-questions.md)。
- **两套运行模式**：极简 / 完整，**MVP 同时发布**，详见 [`design/minimal-mode.md`](./design/minimal-mode.md)。

---

## 8. 后续读什么

- 架构：[`01-architecture.md`](./01-architecture.md)
- 技术栈：[`02-tech-stack.md`](./02-tech-stack.md)
- 路线图：[`03-roadmap.md`](./03-roadmap.md)