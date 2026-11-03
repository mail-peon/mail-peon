import type { Ref } from 'vue'
import type { MailProviderFieldPayload as ProviderField, MailProviderOptionPayload as ProviderOption } from '~/adapters/mail/registry'
import type { MailAccount } from '~/logic/types'
import { computed, ref } from 'vue'

export function useAccountFields(editing: Ref<MailAccount | null>, providers: Ref<ProviderOption[]>) {
/**
 * 哪些「带预设的 host 字段」当前处于**自定义模式**（下拉选中了「自定义…」）。
 *
 * 为什么需要这个显式的状态、而不是从 `config[key]` 推：
 *   选「自定义」时 host 还是空的，而「还没选」时 host 也是空的 ——
 *   两者在数据上一模一样，推不出来。没有它的话，用户一点「自定义」，
 *   输入框会立刻又消失（因为 host 仍为空，看着就像没选）。
 */
  const customHostFields = ref<Record<string, boolean>>({})

  const currentProvider = computed(() =>
    providers.value.find(item => item.value === editing.value?.provider) ?? null,
  )

  /** 协议下拉的选项（antd 的 `Select` 要的是 `{ label, value }` 数据） */
  const providerOptions = computed(() =>
    providers.value.map(item => ({ value: item.value, label: item.label })),
  )

  function defaultConfigFor(provider: ProviderOption | null | undefined): MailAccount['config'] {
    const config: MailAccount['config'] = {}
    for (const field of provider?.fields ?? []) {
      if (field.default !== undefined)
        (config as Record<string, unknown>)[field.key] = field.default
    }
    return config
  }

  function onProviderChange(value: unknown) {
    if (!editing.value)
      return
    const provider = providers.value.find(item => item.value === value) ?? null
    /*
   * 切协议时**保留用户已填的通用字段**（如 user / email 里复用的地址），
   * 但把新协议专属字段补上默认值。
   *
   * 不能整个重置成 `defaultConfigFor()`：用户填了一半再切协议时，
   * 那些填过的值会全部消失 —— 而「切错了再切回来」是很常见的操作。
   */
    editing.value.provider = String(value)
    editing.value.config = { ...defaultConfigFor(provider), ...editing.value.config }
    // 换了协议就换了一批字段（预设也可能不同），自定义模式要重新判定
    syncCustomHostFields(editing.value)
  }

  function setField(key: string, value: unknown) {
    if (!editing.value)
      return
    const config = editing.value.config as Record<string, unknown>
    config[key] = value
  }

  /**
   * 「自定义…」在下拉里的哨兵值。
   *
   * host 是域名/地址，不可能等于这个值，所以用它当哨兵是安全的。
   */
  const CUSTOM_HOST = '__custom__'

  /** 这个带预设的 host 字段现在是不是「自己填」模式 */
  function isCustomHost(key: string): boolean {
    return customHostFields.value[key] === true
  }

  /** 下拉当前应显示的值：预设值 / 「自定义…」 / undefined（还没选） */
  function hostSelectValue(key: string): string | undefined {
    if (isCustomHost(key))
      return CUSTOM_HOST
    const value = fieldValue(key)
    return value === '' ? undefined : value
  }

  /**
   * 下拉选项 = 各家预设 + 末尾一条「自定义…」。
   *
   * ⚠ 这里只放 `value` / `label`，**不放 `note`**。antd 会把 option 对象上的额外字段
   *   原样铺到选项 DOM 上，`note` 会变成一个 `note="需用授权码"` 属性漏在页面上
   *   （之前放过 `payload` 对象，渲染出 `payload="[object Object]"`）。
   *   `note` 由 `presetNote()` 按 value 反查 —— 反查一次很便宜，DOM 干净。
   */
  function hostSelectOptions(field: ProviderField) {
    return [
      ...(field.presets ?? []).map(preset => ({ value: preset.value, label: preset.label })),
      { value: CUSTOM_HOST, label: '自定义…' },
    ]
  }

  /** 选项副标题：按 value 回预设里查 —— 见 `hostSelectOptions` 里为什么不直接塞进 option */
  function presetNote(field: ProviderField, value: string): string | undefined {
    return field.presets?.find(preset => preset.value === value)?.note
  }

  /**
   * 选下拉时：挑预设就回填 host / port / tls（三件一起改，见下）；
   * 挑「自定义…」就切到输入框。
   *
   * ⚠️ 为什么 host / port / tls **一起**改：只写 host 的话，用户从 993 的邮箱切到
   *    另一家非 993 的，端口还留着旧值，点「测试连接」报一个看不懂的错。
   *    `preset.port` / `preset.tls` 缺失时**不动**对应字段（预设可以只想覆盖 host）。
   */
  function onHostSelect(key: string, value: string): void {
    if (!editing.value)
      return
    const config = editing.value.config as Record<string, unknown>

    if (value === CUSTOM_HOST) {
      customHostFields.value[key] = true
      // 清掉上一家的地址，让输入框空着等用户填 —— 留着一个不相干的域名更容易误提交
      config[key] = ''
      return
    }

    customHostFields.value[key] = false
    config[key] = value

    const field = currentProvider.value?.fields.find(item => String(item.key) === key)
    const preset = field?.presets?.find(item => item.value === value)
    if (!preset)
      return

    if (typeof preset.port === 'number')
      config.port = preset.port
    if (typeof preset.tls === 'boolean')
      config.tls = preset.tls
  }

  /**
   * 按账号当前配置，重新判定每个带预设的 host 字段是不是「自定义」。
   *
   * 打开已有账号时用：比如用户之前手填了 `mail.corporate.internal`，
   * 那不匹配任何预设，下拉就该显示「自定义…」并且把输入框亮出来，
   * 而不是显示成「没选」让用户以为配置丢了。
   */
  function syncCustomHostFields(account: MailAccount | null): void {
    const provider = providers.value.find(item => item.value === account?.provider)
    const next: Record<string, boolean> = {}

    for (const field of provider?.fields ?? []) {
      if (!field.presets?.length)
        continue
      const current = String((account?.config as Record<string, unknown> | undefined)?.[field.key] ?? '')
      next[field.key] = current !== '' && !field.presets.some(preset => preset.value === current)
    }

    customHostFields.value = next
  }

  function fieldValue(key: string): string {
    const raw = (editing.value?.config as Record<string, unknown> | undefined)?.[key]
    return raw === undefined || raw === null ? '' : String(raw)
  }

  /**
   * 数字字段的当前值。
   *
   * ⚠ 单独一个函数而不是复用 `fieldValue()` 再 `Number(...)`：
   *   `a-input-number` 要的是**数字或 null**，而「清空输入框」拿到的是 null。
   *   传一个字符串 "NaN" 进去会让那个输入框显示成乱七八糟的东西。
   */
  function fieldNumber(key: string): number | null {
    const raw = (editing.value?.config as Record<string, unknown> | undefined)?.[key]
    return typeof raw === 'number' && Number.isFinite(raw) ? raw : null
  }

  function fieldBool(key: string): boolean {
    return (editing.value?.config as Record<string, unknown> | undefined)?.[key] === true
  }

  /*
 * antd 把几个表单控件的值和回调声明得比我们实际处理的**宽**：
 *
 *   - `a-switch` 的 `update:checked` 给的是 `CheckedType`（`boolean | string`）；
 *   - `a-input-number` 的 `value` / `update:value` 是 `ValueType`（`string | number`）；
 *   - `a-select` 的 `change` 给的是 `SelectValue`（含 `undefined`）。
 *
 * 下面三个包装把它们收窄回真实的类型。写在脚本里而不是在模板上内联断言：
 * 模板里一行塞不下注释，而且 `as` 在模板表达式里很容易被当成别的东西。
 */
  function onToggleUpdate(key: string, checked: unknown): void {
  // antd 的 `CheckedType` 实际是 `boolean | string | number`，而且会随版本变宽，
  // 所以形参收成 `unknown` 再判等 —— 比照抄它的联合类型耐改
    setField(key, checked === true)
  }

  function onNumberUpdate(key: string, value: string | number | null | undefined): void {
  // 清空输入框时 antd 给 `null`：那代表「没有值」，不是 0
    setField(key, typeof value === 'number' && Number.isFinite(value) ? value : undefined)
  }

  function onFieldSelectUpdate(key: string, value: unknown): void {
    onHostSelect(key, String(value ?? ''))
  }
  return { currentProvider, providerOptions, defaultConfigFor, onProviderChange, setField, isCustomHost, hostSelectValue, hostSelectOptions, presetNote, onHostSelect, syncCustomHostFields, fieldValue, fieldNumber, fieldBool, onToggleUpdate, onNumberUpdate, onFieldSelectUpdate }
}
