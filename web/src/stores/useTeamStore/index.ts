import { create } from 'zustand'
import { immer } from 'zustand/middleware/immer'
import { useToastStore } from '@/stores/useToastStore'
import { createSessionSlice } from './session-slice'
import { createStreamSlice, clearReconnectTimer } from './stream-slice'
import { createPendingSlice } from './pending-slice'
import { createUISlice } from './ui-slice'
import type { TeamStore } from './types'

export type {
  AgentStream,
  CacheInvalidation,
  PendingMessage,
  TeamStoreState,
  TeamStoreActions,
  TeamStore,
} from './types'

export const useTeamStore = create<TeamStore>()(
  immer((...a) => ({
    ...createSessionSlice(...a),
    ...createStreamSlice(...a),
    ...createPendingSlice(...a),
    ...createUISlice(...a),
  }))
)

useTeamStore.subscribe((state, prev) => {
  if (state.error && state.error !== prev.error && !state._unloading) {
    useToastStore.getState().push({ tone: 'error', title: 'Agent error', description: state.error })
  }
})

if (typeof window !== 'undefined') {
  const markUnloading = () => {
    useTeamStore.setState((state) => {
      state._unloading = true
      state._abortController?.abort()
      clearReconnectTimer(state)
    })
  }
  window.addEventListener('beforeunload', markUnloading)
  window.addEventListener('pagehide', markUnloading)
}
