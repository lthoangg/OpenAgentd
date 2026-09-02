/**
 * Cross-window BroadcastChannel primitive.
 *
 * Leaf module on purpose: `theme.ts` posts here and `broadcast-sync.ts`
 * listens here *and* applies theme changes, so keeping the channel itself
 * free of feature imports is what stops the two from importing each other.
 */
import type { ThemePreference } from './theme'
import type { CacheInvalidation } from '@/stores/useAgentStore'

export type BroadcastMessage =
  | { type: 'theme_changed'; preference: ThemePreference; storageKey?: string }
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
