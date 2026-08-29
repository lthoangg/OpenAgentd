import { create } from 'zustand'
import { immer } from 'zustand/middleware/immer'
import { useToastStore } from '@/stores/useToastStore'
import { createSessionSlice } from './session-slice'
import { createStreamSlice, clearReconnectTimer } from './stream-slice'
import { createPendingSlice } from './pending-slice'
import { createUISlice } from './ui-slice'
import type { AgentStore } from './types'

export { isAwaitingRestartOutput } from './helpers'

export type {
  AgentStream,
  CacheInvalidation,
  PendingMessage,
  ResolvedQuestion,
  AgentError,
  AgentStoreState,
  AgentStoreActions,
  AgentStore,
} from './types'

export function isProviderError(title?: string, message?: string, code?: string, category?: string): boolean {
  if (category === 'provider') return true
  if (code?.startsWith('provider_') || code === 'agent_not_configured') return true
  const combined = `${title ?? ''} ${message ?? ''}`.toLowerCase()
  return (
    combined.includes('provider') ||
    combined.includes('rate limit') ||
    combined.includes('429') ||
    combined.includes('invalid api key') ||
    combined.includes('authentication') ||
    combined.includes('anthropic') ||
    combined.includes('openai')
  )
}

export function inferErrorTitle(message: string, category?: string): string {
  if (category === 'provider') return 'Provider error'
  if (category === 'network') return 'Network error'
  if (category === 'tool') return 'Tool error'
  if (category === 'user_action') return 'Action failed'
  if (category === 'denied_paths' || category === 'sandbox') return 'Permission denied'

  const lower = message.toLowerCase()
  if (lower.includes('rate limit') || lower.includes('429')) return 'Rate limit exceeded'
  if (
    lower.includes('authentication') ||
    lower.includes('invalid api key') ||
    lower.includes('401') ||
    lower.includes('403')
  ) {
    return 'Provider authentication failed'
  }
  if (
    lower.includes('connection') ||
    lower.includes('timeout') ||
    lower.includes('failed to fetch') ||
    lower.includes('load failed') ||
    lower.includes('network error')
  ) {
    return 'Provider connection failed'
  }
  if (lower.includes('cannot undo') || lower.includes('failed to undo')) return 'Undo failed'
  if (lower.includes('compact') || lower.includes('compaction')) return 'Compaction failed'
  if (lower.includes('redo')) return 'Redo failed'
  if (lower.includes('queue') || lower.includes('send message')) return 'Message failed'
  return 'Agent error'
}

export const useAgentStore = create<AgentStore>()(
  immer((...a) => ({
    ...createSessionSlice(...a),
    ...createStreamSlice(...a),
    ...createPendingSlice(...a),
    ...createUISlice(...a),
  }))
)

useAgentStore.subscribe((state, prev) => {
  if (state.error && state.error !== prev.error && !state._unloading) {
    const err = state.error
    const isObj = typeof err === 'object' && err !== null
    const message = isObj ? err.message : err
    const customTitle = isObj ? err.title : undefined
    const category = isObj ? err.category : undefined
    const code = isObj ? err.code : undefined

    // Provider errors are displayed in-transcript in the chat area and kept there — skip floating toasts for them.
    if (isProviderError(customTitle, message, code, category)) {
      return
    }

    const title = customTitle || inferErrorTitle(message, category)
    useToastStore.getState().push({ tone: 'error', title, description: message })
  }
})

if (typeof window !== 'undefined') {
  const markUnloading = () => {
    useAgentStore.setState((state) => {
      state._unloading = true
      state._abortController?.abort()
      clearReconnectTimer(state)
    })
  }
  window.addEventListener('beforeunload', markUnloading)
  window.addEventListener('pagehide', markUnloading)
}
