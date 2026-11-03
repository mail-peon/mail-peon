import type { SyncDonePayload } from '~/logic/types'
import { onMounted, onUnmounted, ref } from 'vue'
import { onSyncDone } from '~/logic/bridge'

/** Wait for an asynchronous background sync through broadcasts and serial status reads. */
export function useSyncRequest(options: {
  start: () => Promise<{ started: boolean, startedAt?: number }>
  status: () => Promise<SyncDonePayload | null>
  timeoutMs: number
  onDone?: (result: SyncDonePayload) => void
  onTimeout?: () => void
  onStartFailed?: () => void
}) {
  const syncing = ref(false)
  let disposed = false
  let generation = 0
  let startedAt = 0
  let poll: ReturnType<typeof setTimeout> | undefined
  let deadline: ReturnType<typeof setTimeout> | undefined
  let unsubscribe: (() => void) | undefined

  function stop() {
    generation++
    syncing.value = false
    clearTimeout(poll)
    clearTimeout(deadline)
  }

  function receive(result: SyncDonePayload) {
    if (disposed || !syncing.value || (result.finishedAt !== undefined && result.finishedAt < startedAt))
      return
    stop()
    options.onDone?.(result)
  }

  function schedule(revision: number) {
    if (disposed || !syncing.value || revision !== generation)
      return
    poll = setTimeout(async () => {
      const result = await options.status().catch(() => null)
      if (disposed || revision !== generation)
        return
      if (result)
        receive(result)
      schedule(revision)
    }, 1500)
  }

  async function start() {
    if (disposed || syncing.value)
      return
    const revision = ++generation
    startedAt = Date.now()
    syncing.value = true
    let result: { started: boolean, startedAt?: number }
    try {
      result = await options.start()
    }
    catch {
      if (!disposed && revision === generation) {
        stop()
        options.onStartFailed?.()
      }
      return
    }
    if (disposed || revision !== generation)
      return
    if (!result.started) {
      stop()
      options.onStartFailed?.()
      return
    }
    startedAt = result.startedAt ?? startedAt
    deadline = setTimeout(() => {
      if (disposed || revision !== generation)
        return
      stop()
      options.onTimeout?.()
    }, options.timeoutMs)
    schedule(revision)
  }

  onMounted(() => {
    unsubscribe = onSyncDone(receive)
  })
  onUnmounted(() => {
    disposed = true
    stop()
    unsubscribe?.()
  })
  return { syncing, start }
}
