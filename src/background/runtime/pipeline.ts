import type { MailConnectionHooks } from '~/adapters/mail/types'
import type { MailPipeline } from '~/logic/ai/pipeline'
import type { MailAccount } from '~/logic/types'
import { createMailPipeline } from '~/logic/ai/pipeline'
import { createRuleCache } from '~/logic/ai/rule-engine'
import { listAccounts, upsertAccount } from '~/logic/store/accounts'
import { createBrowserNotifier } from '../notifier'

// ---------------------------------------------------------------------------
// 心跳与流水线
// ---------------------------------------------------------------------------

/**
 * 规则的进程内缓存：规则表在一轮同步里不会变，缓存能省掉「每封邮件读一遍全表」。
 * 用户在 Options 里改规则时通过 `rules:*` 消息显式失效。
 */
export const ruleCache = createRuleCache()

export function buildPipeline(): MailPipeline {
  return createMailPipeline({
    notifier: createBrowserNotifier(),
    browserLang: globalThis.navigator?.language ?? 'zh-CN',
    ruleCache,
  })
}

/**
 * Gmail 的 token 轮换回写。
 *
 * provider 层没有存储依赖（它要能在单测里跑），所以刷新出来的 token 通过
 * `hooks.onTokenRefreshed` 交回来，在这里写进账号配置 ——
 * 见 `MailConnectionHooks` 的说明（模块级 sink 会让两个账号并发时串号）。
 */
export function hooksFor(account: MailAccount): MailConnectionHooks {
  return {
    async onTokenRefreshed(token) {
      // 重新读一遍账号：同步过程中用户可能改过配置，用闭包里的旧对象会把改动覆盖掉
      const fresh = (await listAccounts()).find(item => item.id === account.id)
      if (!fresh)
        return
      await upsertAccount({
        ...fresh,
        config: { ...fresh.config, accessToken: token.token, expiresAt: token.expiresAt },
      })
    },
  }
}
