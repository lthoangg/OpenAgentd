/**
 * One server update from this client: start it, then follow the server
 * through its restart until it answers on the new version (or says the
 * update failed). Lives outside the About page, so leaving Settings does
 * not lose it, and the connection banner reads it to say "Updating" while
 * the server is away instead of "Can't reach".
 */
import { create } from 'zustand'
import { getServerUpdate, startServerUpdate, type ServerUpdateStatus } from '@/api/client/server-update'
import { errorMessage } from '@/utils/errors'

export type ServerUpdatePhase =
  | { kind: 'idle' }
  | { kind: 'updating'; from: string; target: string }
  | { kind: 'done'; from: string; to: string }
  | { kind: 'failed'; message: string; log?: string }

/** How often the server is asked while it restarts. */
export const POLL_MS = 2_000
/** A Homebrew upgrade can take minutes; give up after this. */
export const GIVE_UP_MS = 5 * 60_000

interface ServerUpdateStore {
  phase: ServerUpdatePhase
  /** Start the update and follow it; resolves once it is done or failed. */
  start: (options?: { onSettled?: () => void }) => Promise<void>
  reset: () => void
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

/**
 * What one answer during the restart means: `null` keeps waiting. The run
 * is ours when its `started_at` is the one the POST returned.
 */
export function readProgress(status: ServerUpdateStatus, started: { target: string; startedAt: string }): ServerUpdatePhase | null {
  if (status.current === started.target) return { kind: 'done', from: '', to: status.current }
  const last = status.last
  const ours = last?.started_at === started.startedAt
  if (ours && last?.state === 'finished') {
    if (last.ok === false) return { kind: 'failed', message: last.message || 'The update failed.', log: status.log }
    // Finished well, yet the server still runs the old version: it came back
    // before the new one took over, or the feed moved. Say so.
    return { kind: 'failed', message: `The server is still on v${status.current}. ${last.message ?? ''}`.trim(), log: status.log }
  }
  if (!ours && !status.in_progress) {
    return { kind: 'failed', message: 'The server stopped updating before it finished.', log: status.log }
  }
  return null
}

export const useServerUpdateStore = create<ServerUpdateStore>((set, get) => ({
  phase: { kind: 'idle' },
  reset: () => set({ phase: { kind: 'idle' } }),
  start: async (options) => {
    if (get().phase.kind === 'updating') return
    let started
    try {
      started = await startServerUpdate()
    } catch (error) {
      set({ phase: { kind: 'failed', message: errorMessage(error) } })
      options?.onSettled?.()
      return
    }
    const { from, target } = started
    set({ phase: { kind: 'updating', from, target } })
    const deadline = Date.now() + GIVE_UP_MS
    while (Date.now() < deadline) {
      await sleep(POLL_MS)
      let status: ServerUpdateStatus
      try {
        status = await getServerUpdate(false)
      } catch {
        // Down for the restart (or answering 5xx while it starts): wait.
        continue
      }
      const next = readProgress(status, { target, startedAt: started.started_at })
      if (next) {
        set({ phase: next.kind === 'done' ? { kind: 'done', from, to: next.to } : next })
        options?.onSettled?.()
        return
      }
    }
    set({ phase: { kind: 'failed', message: `The server did not come back on v${target} within ${GIVE_UP_MS / 60_000} minutes.` } })
    options?.onSettled?.()
  },
}))

/** True while this client is updating the server (it is expected to be away). */
export function isServerUpdating(phase: ServerUpdatePhase): boolean {
  return phase.kind === 'updating'
}
