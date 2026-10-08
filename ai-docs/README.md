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

### 设计（`design/`）

| 文件 | 说明 |
| --- | --- |
| [storage.md](./design/storage.md) | IndexedDB schema、迁移、初始化门闸、保留数量配置、UID 增量同步 |
| [data-model.md](./design/data-model.md) | 字段定义（MailAccount / PromptRule / Mail / Settings） |
| [minimal-mode.md](./design/minimal-mode.md) | **极简模式设计**（默认 / 仅验证码自动复制） |
| [ai-prompt-design.md](./design/ai-prompt-design.md) | AI 系统提示词设计、输出 Schema、多 Provider 适配 |
| [ui-flows.md](./design/ui-flows.md) | 弹窗、Options、通知的 UI 流（含极简 / 完整两套） |
| [page-toast.md](./design/page-toast.md) | 页面顶部 Toast 设计（替代系统通知） |

### 决策（`decisions/`）

| 文件 | 说明 |
| --- | --- |
| [open-questions.md](./decisions/open-questions.md) | 待决策项（IMAP vs OAuth 等） |

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

- 仓库基于 [`antfu/vitesse-webext`](https://github.com/antfu/vitesse-webext) 模板，已能正常 `pnpm dev`。
- 已完成：模板本身的 Popup / Options / Sidepanel / Background 骨架。
- 未开始：所有与邮箱 + AI 相关的业务代码。
- 本目录下的文档先于代码落地，每完成一项功能勾掉对应里程碑。