# 发版流水线（Chrome Web Store 自动发版）

> 目标：本地一条 `pnpm release` 选个版本号，剩下的（构建 → 测试 → 打包 → GitHub Release →
> 上传商店 → 提交审核）全在 CI 上跑完。这里记的是**一次性配置**怎么做，以及为什么这么做。
>
> 配置文件：[`.github/workflows/release.yaml`](../../.github/workflows/release.yaml)。
> 模板来自同作者的 `offer-hunter/.github/workflows/release.yaml`（已跑通的那份）。

---

## 1. 链路

```
本地 pnpm release
  └ bumpp：选版本号 → 改 package.json → commit → 打 vX.Y.Z tag → push
      └ GitHub Actions（tag 触发 .github/workflows/release.yaml）
          ├ pnpm install --frozen-lockfile
          ├ pnpm build → pnpm test → pnpm pack:zip        → extension.zip
          ├ changelogithub                                 → 建 GitHub Release
          ├ gh release upload                              → 把 zip 挂上去
          ├ chrome-webstore-upload-cli upload              → 传到商店（草稿）
          └ chrome-webstore-upload-cli publish             → 提交审核
```

**版本号只有一个来源**：`package.json` 的 `version`。`scripts/prepare.ts` 生成
`extension/manifest.json` 时从这里取值，所以 bumpp 改一处就够，不用手改清单。

---

## 2. 前提（必须在商店后台先做完，API 做不到）

Chrome Web Store API 只能**更新已有条目**，不能建条目、不能改商店文案/图标/隐私字段
（官方限制，见 [spice-framework/chrome 的说明](https://github.com/spice-framework/chrome/blob/main/docs/releasing.md)）。
所以先手动走一遍：

1. 注册 Chrome Web Store 开发者账号（一次性 $5）。
2. 后台 **Add new item**，上传一个 `pnpm pack:zip` 出来的 `extension.zip`。
3. 填完商店文案 / 隐私 / 分发范围，**手动提交并发布第一版**。
   > 首次发布（以及每次改可见性之后的那次）必须手动 —— API `publish` 不接受。
4. 记下两个 ID（见下节）。

> 还没到上架阶段？没配商店凭据时 workflow 里的商店两步会自动跳过，release 照常成功，
> 照样产出 GitHub Release 和 `extension.zip`。可以先合进去，凭据以后补。

---

## 3. 五个凭据从哪来

| GitHub secret | CLI 环境变量 | 从哪拿 |
| --- | --- | --- |
| `EXTENSION_ID` | `EXTENSION_ID` | 条目详情页 URL 里那串 a–p 字母（32 位），也等于商店链接 `.../detail/<slug>/<id>` 的尾段 |
| `PUBLISHER_ID` | `PUBLISHER_ID` | 开发者后台 **Account** 页（v2 API 必需，不填会 404） |
| `CHROME_CLIENT_ID` | `CLIENT_ID` | Google Cloud 建的 OAuth 客户端（下面第 4 节） |
| `CHROME_CLIENT_SECRET` | `CLIENT_SECRET` | 同上 |
| `CHROME_REFRESH_TOKEN` | `REFRESH_TOKEN` | 用 `npx chrome-webstore-upload-keys` 生成（下面第 4 节） |

> 左边这五个名字是**我们自己定的**，只要和 `release.yaml` 里的 `secrets.*` 一致就行；
> 右边是 `chrome-webstore-upload-cli` 规定的，不能改（workflow 里负责映射）。
> 这套凭据是**账号级**的：一套可以发你名下所有扩展，`EXTENSION_ID` 才区分具体条目 ——
> 所以别把它贴到任何仓库外的地方。

---

## 4. 一次性：拿 Google 的三件套

照着官方指南 [fregante/chrome-webstore-upload-keys](https://github.com/fregante/chrome-webstore-upload-keys) 做，
大约 10 分钟（Google 的界面经常改，以官方指南的截图为准）：

1. <https://console.developers.google.com/apis/credentials> → 建项目（名字随意，只有你自己用）。
2. <https://console.cloud.google.com/auth/overview> → **Get started** 填应用名与邮箱。
   - **有 Google Workspace** → 选 **Internal**（最省事，refresh token 不会过期）。
   - **只有个人 Gmail** → 只能选 **External**。⚠️ 见下面的坑：记得把状态改成 In production。
3. **Create OAuth client** → 类型选 **Desktop app** → 拿到 ✅ `CLIENT_ID` / ✅ `CLIENT_SECRET`。
4. <https://console.cloud.google.com/apis/library/chromewebstore.googleapis.com> → **Enable**。
5. 生成 refresh token：

   ```bash
   npx chrome-webstore-upload-keys
   ```

   它会问你要上面两个 key，然后起一个本地小服务器接 Google 的回调。
   **浏览器里授权时要用有该扩展发布权限的那个 Google 账号**（就是 CWS 后台那个账号）。
   拿到 ✅ `REFRESH_TOKEN`。

   > 备用路子（CLI 打不开浏览器 / 远程机器上）：用
   > [OAuth 2.0 Playground](https://developers.google.com/oauthplayground)，右上齿轮勾
   > *Use your own OAuth credentials* 填 client id/secret，作用域加
   > `https://www.googleapis.com/auth/chromewebstore`，授权后换取 refresh token。

### ⚠️ 坑：refresh token 7 天过期

授权同意屏幕状态是 **External + Testing** 时，Google 只发 **7 天有效**的 refresh token ——
症状是「配好当周能发版，下周开始 CI 报 `invalid_grant`」。所以个人账号也要把
**Publishing status 改成 In production**（这个作用域不需要走审核流程）。
Workspace 账号选 Internal 就没这个问题。

---

## 5. 一次性：填进 GitHub Secrets

仓库 → **Settings → Secrets and variables → Actions → New repository secret**，
逐个加第 3 节表格左边那五个。名字必须一模一样（区分大小写）。

本机装了 `gh` 的话也可以一把梭（`winget install GitHub.cli` 装，`gh auth login` 登录后）：

```powershell
gh secret set EXTENSION_ID          --body "<扩展条目 ID>"
gh secret set PUBLISHER_ID          --body "<发布者 ID>"
gh secret set CHROME_CLIENT_ID      --body "<CLIENT_ID>"
gh secret set CHROME_CLIENT_SECRET  --body "<CLIENT_SECRET>"
gh secret set CHROME_REFRESH_TOKEN  --body "<REFRESH_TOKEN>"

gh secret list    # 核对：应该看到五个
```

---

## 6. 建议：先在本地把凭据验一次

别拿一次正式发版去试凭据 —— 先本地跑同一条命令（它只上传，**不提交审核**）：

```powershell
cd D:\Projects\mail-peon
pnpm build
pnpm pack:zip

$env:EXTENSION_ID          = "<扩展条目 ID>"
$env:PUBLISHER_ID          = "<发布者 ID>"
$env:CLIENT_ID             = "<CLIENT_ID>"
$env:CLIENT_SECRET         = "<CLIENT_SECRET>"
$env:REFRESH_TOKEN         = "<REFRESH_TOKEN>"

npx --yes chrome-webstore-upload-cli@latest upload --source extension.zip --auto-publish=false
```

跑通了，说明五个值都对；再删掉这几个环境变量（`Remove-Item Env:REFRESH_TOKEN` 等），
免得留在 shell 历史里。报错对照：

| 报错 | 多半是 |
| --- | --- |
| `invalid_grant` | refresh token 过期（Testing 状态 7 天）或复制时漏了字符 |
| `404` / `Publisher not found` | `PUBLISHER_ID` 不对 |
| `Item not found` | `EXTENSION_ID` 不对，或该账号不是这个条目的发布者 |
| `uploadState: IN_PROGRESS` 卡住 | 包太大/网络慢，CLI 默认最多等 300 秒（`--max-await-in-progress`） |

---

## 7. 以后每次发版

```powershell
pnpm release      # = bumpp：选版本 → 改 package.json → commit → 打 tag → push
```

之后什么都不用做，去 Actions 页面看就行。想发版但**先不送审**（只把包传成草稿）：
把 `release.yaml` 最后那个 `Publish on Chrome Web Store` step 注释掉，
或者干脆合掉这一步，改成每次去后台手动点提交。

---

## 8. 和 offer-hunter 那份的差异

| | offer-hunter | 这里 |
| --- | --- | --- |
| Firefox / AMO 包 | 有（`pack:firefox` → `extension.xpi`） | **没有**：本仓库还没有 `pack:firefox` 脚本，`pack:xpi` 只是把已建好的 `extension/` 装进 xpi。<br>要加就得先补脚本，并且保持「先打 Chrome → 挪出仓库 → 再打 Firefox」的顺序（`clear` 会删根目录的 `extension.*`） |
| 测试 | `pnpm test:coverage` | `pnpm test`（本仓库没装 `@vitest/coverage-v8`） |
| 没配凭据时 | 跳过商店两步 | 一样（`CWS_READY` 标记） |

> 也没有跑 `pnpm pack`：它 = `run-p pack:*`，其中 `pack:crx` 需要根目录的 `key.pem`
> （`.gitignore` 掉的私钥，CI 上不存在）。商店只吃 zip，所以只跑 `pack:zip`。

---

## 9. 后续读什么

- workflow 本体：[`.github/workflows/release.yaml`](../../.github/workflows/release.yaml)
- 构建产物说明：[`02-tech-stack.md § 7`](../02-tech-stack.md)
- 参照实现：`offer-hunter/.github/workflows/release.yaml`
