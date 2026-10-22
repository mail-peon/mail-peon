/**
 * 集中文案（i18n 钩子，`decisions/open-questions.md` Q12）。
 *
 * 设计文档要求「所有 UI 文案集中在 `src/logic/strings.ts`，不在 `.vue` 里硬编码
 * 中文字符串」。MVP 只交付 `zh-CN`，但**调用方式**已经是 i18n-ready：
 * 将来接 vue-i18n 或自研时**只换 `t()` 的实现，不动调用方**。
 *
 * ⚠ 键名用**英文点分**（`popup.tab.important`）而不是中文键：
 *   中文键在改动文案时会被一起改掉，于是「文案调整」变成「键重命名」——
 *   而漏改一个调用点的表现是界面上直接显示出键名本身。
 */

export interface StringTable {
  [key: string]: string | StringTable
}

const zhCN: StringTable = {
  app: {
    /** 展示名（产品名），两侧的品牌条与各页标题都用它；包名仍是 `mail-peon` */
    name: 'Mail Peon',
    minimalSuffix: '极简模式',
    customSuffix: '自定义',
  },

  common: {
    save: '保存',
    cancel: '取消',
    delete: '删除',
    edit: '编辑',
    add: '新增',
    close: '关闭',
    confirm: '确定',
    loading: '加载中…',
    empty: '暂无数据',
    copy: '复制',
    copied: '已复制 ✓',
    copyFailed: '复制失败',
    test: '测试',
    /** 卡片右下角的展开 / 收起（摘要全文） */
    expand: '展开',
    collapse: '收起',
    /** 密码输入框上的显示 / 隐藏切换 */
    show: '显示',
    hide: '隐藏',
    /** 加载失败时的重试 */
    retry: '重试',
    enabled: '启用',
    disabled: '停用',
    unknownSender: '(未知发件人)',
    noSubject: '(无主题)',
    justNow: '刚刚',
    minutesAgo: '{n} 分钟前',
    hoursAgo: '{n} 小时前',
    daysAgo: '{n} 天前',
  },

  popup: {
    tabImportant: '重要',
    tabAll: '全部',
    tabCode: '验证码',
    tabAd: '营销',
    emptyImportant: '还没有重要邮件',
    emptyAll: '还没有收到邮件',
    emptyCode: '还没有收到验证码',
    emptyAd: '还没有营销邮件',
    emptyAdapter: '还没有「{name}」类型的邮件',
    openOptions: '打开设置',
    openSidepanel: '打开完整面板',
    codeHistory: '验证码 / 确认记录',
    codeEmpty: '还没有收到验证码或确认邮件',
    refresh: '刷新',
    refreshing: '正在检查新邮件',
  },

  mail: {
    code: '验证码',
    confirm: '确认邮件',
    confirmHint: '这是一封需要确认的邮件，点下面的按钮继续。',
    openConfirm: '打开确认链接',
    confirmInvalid: '确认链接无效，已阻止打开',
    confirmFailed: '打开确认链接失败',
    customType: '自定义类型',
    /*
     * ⚠ 「读不到邮件」和「没有邮件」必须是两句不同的话。
     *
     *   以前 Popup 在 `mail:list` 失败时也会显示「还没有收到邮件」——
     *   而 `send` 失败返回的是空列表兜底值，两者在数据上分不开。
     *   用户刚收到一封验证码，界面却告诉他没收到过邮件：这是在陈述假事实。
     */
    loadFailed: '读取邮件失败',
    loadFailedHint: '没有收到后台的响应。可能是扩展的后台服务刚被回收，重试一次通常就好。',
    /*
     * ⚠ 删除**失败**必须说出来。`trash:trash` 在邮件已经不在库里时返回
     *   `{ ok: false, error }`，而确认弹窗是先关再执行的 —— 不看返回值的话，
     *   弹窗照关、邮件还在列表里，用户只会觉得「点了没反应」。
     */
    trashFailed: '删除失败，邮件可能已经不在列表里了',
    /**
     * 倒计时两侧的状态词。
     *
     * 「有效」而不是「剩余」：右侧是**状态**，左侧才是数字。两个词分开读得通
     * （`5:00` + `有效`），合起来也读得通（`5:00 有效`）。
     */
    codeValid: '有效',
    codeExpired: '失效',
    summary: '摘要',
    markRead: '标记已读',
    markUnread: '标记未读',
    /**
     * 「不再显示」。
     *
     * ⚠ 这个键曾经**漏了**，而 `t()` 查不到时返回键名本身 —— 于是展开卡片上
     *   那两个按钮里有一个显示成 `mail.dismiss`。`t()` 返回键名而不是空串正是
     *   为了让这种遗漏一眼可见（见 `t()` 的说明），这里如实记一笔。
     */
    dismiss: '不再显示',
    /** 卡片上那个文字按钮 */
    copy: '复制',
    /**
     * 复制成功的提示。
     *
     * ⚠ 带 `√` 而不是只变绿：色觉障碍用户看不出「绿了」，
     *   而符号 + 文字是两重信号。文案也要写出**结果**（复制成功），
     *   不只是状态（已复制）—— 前者回答了「成功了没有」。
     */
    copyDone: '√ 复制成功',
    /** 卡片右上角那个垃圾桶按钮的提示文案（用户看到的是「删除」，底层是移入回收站） */
    trash: '删除',
    pending: 'AI 处理中…',
    degraded: '降级',
    degradedTip: 'AI 处理失败，以上是邮件基础信息',
    minimalCaptured: '该邮件为极简模式捕获，无摘要',
  },

  toast: {
    codeLabel: '验证码',
    /**
     * ⚠ 自动复制成功的那句确认是 `autoDone`（灰色、不加粗）：成功是默认预期，
     *   只需要安静地说一句。绿色加粗的 `copyDone` 留给「用户刚点了复制」那一下
     *   —— 那是他做的一个动作，值得一个明确的结果（`page-toast.md § 3.3`）。
     */
    autoDone: '√ 已复制',
    copyFailed: '自动复制失败',
    /** 文字按钮的文案（Popup 列表项里那个同款） */
    copy: '复制',
    copyDone: '√ 复制成功',
  },

  options: {
    title: 'Mail Peon · 设置',
    navGeneral: '通用',
    navAccounts: '账号',
    navRules: '提示词',
    navAdapters: '适配器',
    navAi: 'AI 配置',
    navBlocked: '屏蔽列表',
    navTrash: '回收站',
    navAbout: '关于',
    /*
     * ⚠ 读取设置失败时**必须**有个出口。以前这里只有一个 `<a-spin v-if="!app">`，
     *   而 `send` 失败返回的是 `app: null` —— 与「加载中」无法区分，
     *   界面就永远转圈。
     */
    loadFailed: '读取设置失败',
    loadFailedHint: '没有收到后台的响应。可能是扩展的后台服务刚被回收，重试一次通常就好。',
  },

  trash: {
    title: '回收站',
    intro: '这里放的是已删除的邮件。邮件本身还在，所以可以恢复；点「彻底删除」才会真的从记录里移除，那时无法撤销。',
    autoDelete: '失效验证码自动删除',
    autoDeleteHint: '开启后，验证码邮件过了失效时间再等 30 秒，就自动移到这里。留 30 秒是为了盖住失效时刻的推算误差（避免误删其实还有效的验证码）。',
    emptyAction: '清空回收站',
    emptyDone: '已彻底删除 {n} 封',
    emptyAlready: '回收站已经是空的',
    /* 确认弹窗（两处删除共用：彻底删除一封 / 清空回收站） */
    confirmEmptyTitle: '清空回收站？',
    confirmEmptyMessage: '将彻底删除回收站里的 {n} 封邮件，此操作无法撤销。',
    confirmDeleteTitle: '彻底删除这封邮件？',
    confirmDeleteMessage: '「{subject}」将被永久移除，此操作无法撤销。',
    /* 下面两条给的是**邮件列表**里的删除确认（`logic/trash-confirm.ts`），不是本页的 */
    confirmTrashTitle: '删除这封邮件？',
    confirmTrashMessage: '「{subject}」将被删除，可在「设置 · 回收站」里恢复。',
    opFailed: '操作失败',
    /*
     * ⚠ `n` 用**真实总数**（`trash:list` 的 `total`），不是列表长度：
     *   列表被截断到 500，拿它当总数会让「将彻底删除 {n} 封」少报，
     *   而实际执行的是全部。
     */
    count: '共 {n} 封',
    loading: '加载中…',
    emptyList: '回收站是空的',
    emptyListHint: '在弹窗里把鼠标移到邮件右上角的时间上，会出现一个删除按钮。',
    colFrom: '发件人',
    colSubject: '主题',
    colCode: '验证码',
    colTrashedAt: '删除时间',
    colActions: '操作',
    restore: '恢复',
    deleteForever: '彻底删除',
    restoreDone: '已恢复',
    deleteDone: '已彻底删除',
  },

  general: {
    mode: '模式',
    /**
     * 模式切换两侧的**短标签**（开关中间）。
     *
     * ⚠ 括号里的解释已经挪到下面两行的 `modeMinimalDesc` / `modeFullDesc` ——
     *   `极简模式（仅验证码）` 这种写法挤在开关两边会把开关推歪，
     *   而且两个标签长度差太多时「开关在中间」看起来并不居中。
     */
    modeMinimal: '极简模式',
    modeFull: '自定义',
    /** 模式说明（开关下方，一行一个模式，共两行） */
    modeMinimalDesc: '固定启用「验证码」和「确认邮件」，其他适配器关闭；开关在「适配器」页锁定',
    modeFullDesc: '自由启用 / 编辑 / 新增适配器，包含总结与自定义类型',
    /** 完整模式通用页的第一个卡片标题 */
    behavior: '行为',
    /** 完整模式通用页的最后一个卡片标题（导出 / 导入 / 清空） */
    data: '数据',
    excludeAds: '排除广告 / 营销邮件',
    excludeAdsHint: '被判为广告的邮件仍会被 AI 处理，可在弹窗「营销」分区查看。',
    blockedEnabled: '启用排除邮箱',
    notifyOnNew: 'Badge 提示新邮件',
    autoCheck: '自动检查新邮件',
    autoCheckHint: '打开弹窗时会立即检查一次；后台按这个间隔自动检查。间隔越短越及时，但连接邮箱越频繁。',
    autoCheckUnit: '分钟',
    popupDefaultTab: '弹窗默认筛选',
    retention: '邮件保留数量',
    retentionUnlimited: '无限',
    retentionUnit: '条',
    usage: '存储用量',
    usageText: '{count} 条 / {limit} 上限，约 {size}',
    usageUnlimitedText: '{count} 条，约 {size}',
    syncNow: '立即同步增量',
    syncing: '同步中…',
    syncDone: '同步完成：拉取 {fetched} 封，屏蔽 {blocked} 封，失败 {failed} 封',
    syncFirstTime: '首次同步只记录同步位置，不会拉取历史邮件',
    clearMails: '清空邮件列表',
    exportSettings: '导出设置',
    importSettings: '导入设置',
    clearAll: '清空所有数据',
    privacyTitle: '隐私声明',
    privacyBody: '邮箱凭据当前以明文存储在本机浏览器中，不会上传到任何服务器。请勿在公共电脑使用本扩展。',
    aiKeyMissing: '验证码 / 确认邮件处理需要先配置 AI Key',
    aiKeyMissingAction: '去 AI 配置',
    accountCount: '账号 · {n} 个',
    confirmClearMails: '确定要清空所有已保存的邮件吗？此操作不可撤销。',
    confirmClearAll: '确定要清空所有数据吗？账号、规则、设置、邮件将全部删除，此操作不可撤销。',
    /*
     * ⚠ 这两条存在的理由：不可撤销的操作**必须**在失败时说出来。
     *   以前 `onClearMails` / `onClearAll` 不看 `send` 的返回值就报成功，
     *   而消息失败时 `send` 返回的是兜底值 `{ ok: false }` ——
     *   于是「什么都没删掉」和「已清空」在界面上长得一模一样。
     */
    clearMailsDone: '已清空邮件列表',
    clearMailsFailed: '清空邮件列表失败：没有收到后台确认，请重试',
    clearAllDone: '已清空所有数据',
    clearAllFailed: '清空所有数据失败：没有收到后台确认，请重试',
  },

  accounts: {
    /**
     * ⚠ 文案里**不带 `+`**：加号由按钮里那个 UnoCSS 图标（`i-pixelarticons-plus`）出。
     *   两边都写，按钮上就是「两个加号」——加号只保留 icon 那一份。
     */
    add: '新增账号',
    empty: '还没有添加邮箱账号',
    label: '备注名',
    labelPlaceholder: '工作邮箱',
    /** 邮箱地址（账号的唯一标识，改它要重建索引） */
    email: '邮箱地址',
    emailPlaceholder: 'me@example.com',
    provider: '协议',
    test: '测试连接',
    testing: '测试中…',
    testOk: '测试通过',
    resetCursor: '重置同步位置',
    resetCursorDone: '已重置；下次心跳从最新邮件开始',
    lastSync: '上次同步',
    never: '从未同步',
    /** 卡片右上角的连接状态（颜色见 `options/pages/accounts-status.ts`） */
    statusConnected: '已连接',
    /**
     * 正在重置同步位置（黄灯）。
     * 「正在测试连接」直接复用按钮上那个 `accounts.testing`（'测试中…'）——
     * 同一件事在两个地方叫两个名字最容易误导。
     */
    resetting: '重置中…',
    /** 这一次「测试连接 / 重置同步位置」失败 */
    statusTestFailed: '连接失败',
    /** 上一次同步留下的错误（`MailAccount.lastError`） */
    statusFailed: '同步失败',
    statusDisabled: '已停用',
    statusNeverSynced: '未同步',
    disabledHint: '这个账号不参与后台同步；启用后下一轮心跳会连它。',
    disabledSuffix: '（账号已停用，不参与后台同步）',
    neverSyncedHint: '还没有同步过。首次同步只记录同步位置，不会拉取历史邮件。',
    editTitle: '编辑账号',
    addTitle: '新增账号',
    deleteConfirm: '删除账号后，该账号已保存的邮件也会一并删除。确定继续吗？',
    enableLabel: '启用（参与后台同步）',
  },

  rules: {
    /** 同 `accounts.add`：`+` 交给按钮的图标，文案里不再自带（它还是弹窗标题） */
    add: '新增规则',
    empty: '还没有自定义规则；所有邮件会使用内置默认规则',
    defaultRule: '默认规则（内置）',
    defaultRuleHint: '没有任何自定义规则命中时使用；按主题给出基础 system prompt。',
    name: '规则名',
    namePlaceholder: 'GitHub 通知',
    matchers: '匹配（每行一条）',
    matchersHint: '含 @ 视为邮箱精确匹配（如 me@a.com），否则按域名匹配（如 github.com）',
    prompt: '提示词',
    promptPlaceholder: '这是来自我自部署代码系统的通知：\n- 如果包含 ERROR / Failed，urgency=high',
    promptHint: '提示词会追加在基础 system prompt 之后，不能修改输出 JSON 结构。',
    moveUp: '上移',
    moveDown: '下移',
    alwaysCopyCode: '本规则强制自动复制验证码',
    alwaysSkipAd: '本规则始终视为非广告',
    deleteConfirm: '规则「{name}」将被删除，此操作无法撤销。',
    /** 列表里那行匹配条件的标题（内置规则的角标也是这个词） */
    builtinTag: '兜底',
  },

  adapters: {
    title: '适配器',
    intro: '每个适配器是一种邮件类型 + 一段提示词。每封邮件都会带上所有启用适配器的提示词。',
    promptBudget: '提示词共 {chars} 字（约 {tokens} tokens）',
    builtinTag: '内置',
    customTag: '自定义',
    fallbackTag: '兜底',
    add: '新增自定义类型',
    empty: '还没有自定义类型',
    name: '类型名',
    namePlaceholder: '账单提醒',
    prompt: '提示词',
    promptPlaceholder: '当邮件是账单 / 发票时，告诉我金额、到期日和是否需要付款。',
    promptHint: '提示词追加在基础 system 之后，不能修改输出 JSON 结构。',
    userPrompt: '用户补充规则（选填）',
    userPromptPlaceholder: '例如：邮件里有两个验证码 A、B 时，只用 A。',
    reset: '恢复默认',
    resetDone: '已恢复默认',
    enabled: '启用',
    priority: '优先级 #{n}',
    stackable: '可叠加',
    fallback: '仅当没有其它类型命中时',
    moveUp: '上移',
    moveDown: '下移',
    deleteConfirm: '类型「{name}」将被删除，此操作无法撤销。',
    minimalLocked: '极简模式固定启用「验证码」和「确认邮件」；适配器开关需切到「自定义」模式，验证码的自动复制可随时调整。',
    noPrompt: '尚未填写提示词，这个类型不会生效。',
    unnamed: '未命名类型',
    code: {
      name: '验证码',
      description: '提取一次性验证码，可自动复制；有有效期时显示倒计时。',
      autoCopyCode: '自动复制验证码',
      autoCopyCodeHint: '提取到验证码后写入剪贴板；关闭后仍会入库，toast 里给「点击复制」。',
    },
    confirm: {
      name: '确认邮件',
      description: '注册确认 / 邮箱验证 / 账号激活，提供一个确认按钮。',
    },
    summary: {
      name: '总结',
      description: '没有任何类型命中时生成摘要；命中其它类型时自动跳过。',
    },
  },

  ai: {
    /** 卡片标题（nav 里那项叫「AI 配置」，卡片里说明它是配置本体） */
    cardTitle: 'AI 配置',
    platform: '平台',
    baseUrl: 'Base URL',
    apiKey: 'API Key',
    model: 'Model',
    thinking: '启用思考模式',
    thinkingHint: 'DeepSeek 等平台默认已关闭；开启会消耗大量 token 且可能导致输出为空。',
    /*
     * ⚠ 有些平台**没有**思考模式（OpenAI / Anthropic 的声明里 `thinkingToggle: false`），
     *   协议层对它们根本不发那个参数。不把这件事说出来，用户勾了之后只会觉得
     *   「开了没反应」。
     */
    thinkingUnsupported: '当前平台没有思考模式，此项不可用。',
    outputLanguage: '输出语言',
    outputLanguageBrowser: '跟随浏览器（推荐）',
    outputLanguageEmail: '跟随邮件',
    test: '测试连通',
    testing: '测试中…',
    testOk: '连接成功',
    /** 状态徽标上的短状态词（颜色见 `options/pages/AiPage.vue` 的 `aiStatus`） */
    statusUntested: '未测试',
    statusFail: '连接失败',
    /** 悬停详情：`DeepSeek · deepseek-flash` 后面接这句 */
    untestedHint: '还没有测试过这份配置',
    baseUrlPlaceholder: '留空则使用平台默认：{url}',
    modelPlaceholder: '留空则使用平台默认：{model}',
    notConfigured: '尚未配置',
  },

  blocked: {
    enabled: '启用排除',
    account: '当前账号',
    addPlaceholder: 'noreply@spam.com 或 tracker.com',
    add: '新增屏蔽',
    kindEmail: '邮箱',
    kindDomain: '域名',
    batch: '批量粘贴',
    batchPlaceholder: '每行一项；含 @ 视为邮箱，否则视为域名\nnoreply@spam.com\ntracker.com',
    batchApply: '导入',
    empty: '屏蔽列表为空',
    hint: '命中的邮件会被完全跳过：不入库、不调 AI、不弹通知。仅对本账号生效。',
  },

  about: {
    title: '关于 Mail Peon',
    intro: '浏览器里的邮件助理，AI 挑出真正重要的邮件，验证码自动复制、确认邮件一键打开',
    modeTitle: '两种运行模式',
    modeMinimal: '极简模式',
    modeFull: '自定义模式',
    modeMinimalDesc: '固定启用「验证码」和「确认邮件」：验证码自动复制并弹提示；确认邮件只在卡片里给一个打开链接的按钮。其它邮件直接丢弃。',
    modeFullDesc: '可自由启用、排序、新增邮件类型适配器；支持 AI 总结（兜底）、广告屏蔽、提示词规则与排除邮箱。',
    storageTitle: '数据存在哪',
    storageDesc: '账号、规则、邮件全部存在本机 IndexedDB，不会上传到任何服务器。',
    aiTitle: '邮件正文会发给谁',
    aiDesc: '只在调用 AI 时把「主题 + 正文片段」发到你配置的 AI 平台；极简模式下正文根本不存储。',
    shortcutsTitle: '其它入口',
    shortcutsDesc: '点击工具栏图标打开弹窗；侧边栏（Chrome 侧栏 / Firefox 侧栏）提供完整列表。',
    peonHallTitle: '配套桌面端（peon-hall）',
    /*
     * About 页卡片里的「为什么需要装」—— 只一句，不堆安全细节。
     *
     * IMAP provider 的 `availabilityNote` 也说了同一件事，但**故意措辞不同**
     * （这里 22 字、那边 18 字）—— 不同决策点用各自的长度，硬同步成"同一份文案"
     * 会把"为什么装"也拉成三段话。
     *
     * 安全细节（TLS 握手、本机监听）用户**自己知道**就好 —— 想看完整的：
     *   - `providers/imap/index.ts` 旧版本的 `availabilityNote` 注释里有完整说明
     *   - `docs/privacy-policy.md` 的「数据存储」一节
     */
    peonHallWhyNeeded: '浏览器扩展不能直接连接 IMAP，需要本机中继转发。',
    peonHallDownload: '下载 peon-hall',
  },
}

/** 当前语言表（MVP 只有 zh-CN） */
const current = zhCN

function lookup(table: StringTable, path: string[]): string | undefined {
  let node: string | StringTable | undefined = table
  for (const segment of path) {
    if (typeof node !== 'object' || node === null)
      return undefined
    node = node[segment]
  }
  return typeof node === 'string' ? node : undefined
}

/**
 * 取文案并做变量替换。
 *
 * 变量语法是 `{name}`（而不是模板字符串）：文案表是**数据**，
 * 用模板字符串的话，取文案这件事就变成了「执行一段代码」，
 * 将来接 vue-i18n 时也没法直接复用。
 *
 * 查不到时**返回键名本身**：界面上出现 `general.usageText` 一眼就知道是漏了文案，
 * 而返回空字符串会让人以为是渲染问题。
 */
export function t(key: string, vars?: Record<string, unknown>): string {
  const value = lookup(current, key.split('.')) ?? key
  if (!vars)
    return value

  return value.replace(/\{(\w+)\}/g, (match, name: string) => {
    const replacement = vars[name]
    return replacement === undefined || replacement === null ? match : String(replacement)
  })
}
