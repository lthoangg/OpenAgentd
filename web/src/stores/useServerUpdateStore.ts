/**
 * One server update from this client: start it, then follow the server
 * through its restart until it answers on the new version (or says the
 * update failed). Lives outside the About page, so leaving Settings does
 * not lose it, and the connection banner reads it to say "Updating" while
 * the server is away instead of "Can't reach".
 */
import { create } from 'zustand'
import type { ServerUpdateStatus } from '@/api/client/server-update'
import { errorMessage } from '@/utils/errors'
import { UPDATE_IDLE, serverUpdateMachine, type ServerUpdateEvent, type ServerUpdatePhase } from '@/stores/server-update-state'

export type { ServerUpdatePhase } from '@/stores/server-update-state'

/** How often the server is asked while it restarts. */
export const POLL_MS = 2_000
/** A Homebrew upgrade can take minutes; give up after this. */
export const GIVE_UP_MS = 5 * 60_000
/** A desktop app downloads the whole app before it restarts. */
const DESKTOP_APP_GIVE_UP_MS = 15 * 60_000

/** How long to follow an update the server started with `method`. */
export function giveUpAfter(method: string | undefined): number {
  return method === 'desktop_app' ? DESKTOP_APP_GIVE_UP_MS : GIVE_UP_MS
}

interface ServerUpdateStore {
  /** Changed only through ``serverUpdateMachine`` (``server-update-state.ts``). */
  updatePhase: ServerUpdatePhase
  /** Start the update and follow it; resolves once it is done or failed. */
  start: (options?: { onSettled?: () => void }) => Promise<void>
  reset: () => void
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

/**
 * Which `start` may still write the phase. A newer start or a reset bumps
 * it, so an older loop that wakes up later stops instead of overwriting.
 */
let run = 0

/**
 * What one answer during the restart means: `null` keeps waiting. The run
 * is ours when its `started_at` is the one the POST returned.
 */
export function readProgress(
  status: ServerUpdateStatus,
  started: { target: string; startedAt: string },
): Extract<ServerUpdatePhase, { kind: 'done' | 'failed' }> | null {
  if (status.current === started.target) return { kind: 'done', from: '', to: status.current }
  const last = status.last
  const ours = last?.started_at === started.startedAt
  if (ours && last?.state === 'finished') {
    if (last.ok === false) return { kind: 'failed', message: last.message || 'The update failed.', log: status.log }
    // The release list moved on while it ran: it installed a newer one.
    if (last.to && last.to === status.current) return { kind: 'done', from: '', to: status.current }
    // Finished well, yet the server still runs the old version: it came back
    // before the new one took over, or the feed moved. Say so.
    return { kind: 'failed', message: `The server is still on v${status.current}. ${last.message ?? ''}`.trim(), log: status.log }
  }
  if (!ours && !status.in_progress) {
    return { kind: 'failed', message: 'The server stopped updating before it finished.', log: status.log }
  }
  return null
}

export const useServerUpdateStore = create<ServerUpdateStore>((set, get) => {
  const move = (event: ServerUpdateEvent) => set((s) => ({ updatePhase: serverUpdateMachine.transition(s.updatePhase, event) }))
  return {
    updatePhase: UPDATE_IDLE,
    reset: () => {
      run += 1
      move({ type: 'reset' })
    },
    start: async (options) => {
      if (!serverUpdateMachine.can(get().updatePhase, { type: 'start' })) return
      // Set before the first await, so a second click in the meantime sees it.
      const mine = ++run
      move({ type: 'start' })
      const current = () => run === mine
      // The connection banner reads this store at startup; the API calls load
      // only when an update starts, keeping them out of the startup bundle.
      let getServerUpdate: typeof import('@/api/client/server-update').getServerUpdate
      let started
      try {
        const api = await import('@/api/client/server-update')
        getServerUpdate = api.getServerUpdate
        started = await api.startServerUpdate()
      } catch (error) {
        if (current()) {
          move({ type: 'failed', message: errorMessage(error) })
          options?.onSettled?.()
        }
        return
      }
      if (!current()) return
      const { from, target } = started
      move({ type: 'accepted', from, target })
      const giveUp = giveUpAfter(started.method)
      const deadline = Date.now() + giveUp
      while (Date.now() < deadline) {
        await sleep(POLL_MS)
        if (!current()) return
        let status: ServerUpdateStatus
        try {
          status = await getServerUpdate(false)
        } catch {
          // Down for the restart (or answering 5xx while it starts): wait.
          continue
        }
        if (!current()) return
        const next = readProgress(status, { target, startedAt: started.started_at })
        if (next) {
          if (next.kind === 'done') move({ type: 'finished', to: next.to })
          else move({ type: 'failed', message: next.message, log: next.log })
          options?.onSettled?.()
          return
        }
      }
      if (current()) {
        move({ type: 'failed', message: `The server did not come back on v${target} within ${giveUp / 60_000} minutes.` })
        options?.onSettled?.()
      }
    },
  }
})

/** True while this client is updating the server (it is expected to be away). */
export function isServerUpdating(phase: ServerUpdatePhase): boolean {
  return phase.kind === 'updating'
}
