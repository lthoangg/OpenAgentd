import type { QueryClient } from '@tanstack/react-query'
import type { ThemePreference } from './theme'
import { applyTheme, resolveTheme } from './theme'
import { applyCacheInvalidations } from '@/stores/cache-invalidation-bridge'
import type { CacheInvalidation } from '@/stores/useTeamStore'

export type BroadcastMessage =
  | { type: 'theme_changed'; preference: ThemePreference }
  | { type: 'cache_invalidated'; events: CacheInvalidation[] }

const CHANNEL_NAME = 'openagentd-sync'

let channel: BroadcastChannel | null = null

export function getBroadcastChannel(): BroadcastChannel | null {
  if (typeof window === 'undefined' || typeof BroadcastChannel === 'undefined') {
    return null
  }
  if (!channel) {
    channel = new BroadcastChannel(CHANNEL_NAME)
  }
  return channel
}

export function broadcastMessage(msg: BroadcastMessage): void {
  const ch = getBroadcastChannel()
  if (ch) {
    try {
      ch.postMessage(msg)
    } catch {
      // Broadcast channel might be closed or unsupported in current environment
    }
  }
}

export function initBroadcastSync(queryClient: QueryClient): () => void {
  const ch = getBroadcastChannel()
  if (!ch) return () => {}

  const onMessage = (event: MessageEvent<BroadcastMessage>) => {
    const data = event.data
    if (!data || typeof data !== 'object') return

    if (data.type === 'theme_changed') {
      applyTheme(resolveTheme(data.preference))
    } else if (data.type === 'cache_invalidated' && Array.isArray(data.events)) {
      applyCacheInvalidations(queryClient, data.events)
    }
  }

  ch.addEventListener('message', onMessage)
  return () => {
    ch.removeEventListener('message', onMessage)
  }
}
