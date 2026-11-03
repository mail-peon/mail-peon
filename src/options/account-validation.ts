import type { MailProviderOptionPayload as ProviderOption } from '~/adapters/mail/registry'
import type { MailAccount } from '~/logic/types'

/**
 * 校验失败的结果。
 *
 * ⚠ 带上 `key` 而不是只给一句话：界面要拿它把**出错的那个字段**滚到眼前
 *   （弹窗的字段区是可滚动的，出错字段很可能不在视口里）。
 */
export interface ValidationFailure {
  /** 字段 key（与 `a-form-item` 的 `name` 对应） */
  key: string
  message: string
}

/**
 * 按 provider 声明校验必填字段。
 *
 * ⚠ 之前 `required: true` **只用来渲染一个 `*`**，保存与「测试连接」都不检查 ——
 *   于是漏填中继地址、或把地址填成 `127.0.0.1:41316` / `https://…`，
 *   都会一路存下去，直到建立 WebSocket 时才失败。而那时的报错是
 *   「无法连接中继：…」，用户根本不会联想到是「地址少写了协议头」。
 *
 * 校验规则来自 `definition.fields`（单一信源），所以加一个 provider 字段就会自动
 * 被校验，不需要在这里补 `if`。
 *
 * @returns 带字段 key 的错误信息；通过时返回 null
 */
export function validateAccount(account: MailAccount, providers: ProviderOption[]): ValidationFailure | null {
  const provider = providers.find(item => item.value === account.provider)

  for (const field of provider?.fields ?? []) {
    if (!field.required)
      continue

    const value = (account.config as Record<string, unknown>)[field.key]
    const missing = field.type === 'number'
      // 数字字段：`0` 与空串都算没填（端口 0 不是有效值）
      ? typeof value !== 'number' || !Number.isFinite(value) || value <= 0
      : typeof value !== 'string' || !value.trim()

    if (missing)
      return { key: String(field.key), message: `请填写「${field.label}」` }
  }

  return validateRelayUrl(account)
}

/**
 * 中继地址的格式校验。
 *
 * 单独一条而不是塞进上面的通用循环：这里能给出**可操作**的提示
 * （「要写 `ws://` 开头」），而通用循环只能说「请填写」。
 */
function validateRelayUrl(account: MailAccount): ValidationFailure | null {
  const raw = account.config.relayUrl?.trim()
  // 只有用得上中继的 provider 才校验（Gmail 那条路不经过中继）
  if (account.provider !== 'imap')
    return null

  if (!raw)
    return { key: 'relayUrl', message: '请填写「WebSocket 中继地址」（装好 peon-hall 后填 ws://127.0.0.1:41316/）' }

  if (!/^wss?:\/\//i.test(raw)) {
    return {
      key: 'relayUrl',
      message: `中继地址要以 ws:// 或 wss:// 开头（当前是「${raw}」）。`
        + '本机中继写 ws://127.0.0.1:41316/',
    }
  }

  try {
    void new URL(raw)
  }
  catch {
    return { key: 'relayUrl', message: `中继地址不是合法 URL：「${raw}」` }
  }

  return null
}
