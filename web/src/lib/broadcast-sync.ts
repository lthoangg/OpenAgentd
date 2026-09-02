import type { QueryClient } from '@tanstack/react-query'
import { applyTheme, resolveTheme, themeStorageKey } from './theme'
import { applyCacheInvalidations } from '@/stores/cache-invalidation-bridge'
import { getBroadcastChannel, type BroadcastMessage } from './broadcast-channel'

export { broadcastMessage, getBroadcastChannel, type BroadcastMessage } from './broadcast-channel'

export function initBroadcastSync(queryClient: QueryClient): () => void {
  const ch = getBroadcastChannel()
  if (!ch) return () => {}

  const onMessage = (event: MessageEvent<BroadcastMessage>) => {
    const data = event.data
    if (!data || typeof data !== 'object') return

    if (data.type === 'theme_changed') {
      if (!data.storageKey || data.storageKey === themeStorageKey()) {
        applyTheme(resolveTheme(data.preference))
      }
    } else if (data.type === 'cache_invalidated' && Array.isArray(data.events)) {
      applyCacheInvalidations(queryClient, data.events)
    }
  }

  ch.addEventListener('message', onMessage)
  return () => {
    ch.removeEventListener('message', onMessage)
  }
}
