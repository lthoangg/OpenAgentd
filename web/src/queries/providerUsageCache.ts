/**
 * What the usage queries hold beside the TanStack cache: blocks that must
 * survive a refetch, and the helpers that forget one account's reading.
 *
 * Kept free of runtime react-query imports (types only) so a component that
 * only needs to forget a reading does not pull the hooks module in.
 */
import type { QueryClient, QueryKey } from '@tanstack/react-query'

import type { ProviderUsageResponse } from '@/api/client'
import { ProviderUsageError, cooldownRemainingMs, snapshotUpdatedAtMs } from '@/lib/provider-usage'
import { queryKeys } from './keys'

/**
 * Blocks live beside the query cache, not in it: TanStack clears a dataless
 * query's error the moment a refetch starts, which would let a manual refresh
 * walk straight past the retry time. Two kinds: a rate limit (until its retry
 * time) and a sign-in that needs attention (until the account is reconnected).
 */
const blocks = new WeakMap<QueryClient, Map<string, ProviderUsageError>>()
const MAX_BLOCKS = 200

function blockStore(client: QueryClient): Map<string, ProviderUsageError> {
  let store = blocks.get(client)
  if (!store) {
    store = new Map()
    blocks.set(client, store)
  }
  return store
}

function isBlocking(error: ProviderUsageError): boolean {
  return error.kind === 'credentials' || cooldownRemainingMs(error) > 0
}

/** The error holding this reading back from the daemon, or null when it may ask. */
export function activeBlock(client: QueryClient, key: QueryKey): ProviderUsageError | null {
  const store = blockStore(client)
  const id = JSON.stringify(key)
  const held = store.get(id)
  if (!held) return null
  if (isBlocking(held)) return held
  store.delete(id)
  return null
}

export function holdBlock(client: QueryClient, key: QueryKey, error: ProviderUsageError): void {
  const store = blockStore(client)
  for (const [id, held] of store) {
    if (!isBlocking(held)) store.delete(id)
  }
  while (store.size >= MAX_BLOCKS) {
    const oldest = store.keys().next()
    if (oldest.done) break
    store.delete(oldest.value)
  }
  store.set(JSON.stringify(key), error)
}

export function releaseBlock(client: QueryClient, key: QueryKey): void {
  blockStore(client).delete(JSON.stringify(key))
}

/**
 * Forget every block this client holds. For a switch to another server, which
 * clears the query cache: the same credential id there is a different
 * account and must not inherit a cooldown or sign-in block from the old one.
 * (An ordinary cache drop does not call this: the block outlives the reading.)
 */
export function clearProviderUsage(client: QueryClient): void {
  blocks.delete(client)
}

/**
 * Forget cached usage and any block for one account (or, without
 * `credentialId`, for the whole provider): its sign-in went away, so what was
 * held no longer describes it.
 */
export function forgetProviderUsage(client: QueryClient, providerId: string, credentialId?: string): void {
  const key = queryKeys.settings.providerUsage(providerId, credentialId)
  const prefix = JSON.stringify(key).slice(0, -1)
  const store = blockStore(client)
  for (const id of [...store.keys()]) {
    if (id === JSON.stringify(key) || (!credentialId && id.startsWith(`${prefix},`))) store.delete(id)
  }
  client.removeQueries({ queryKey: key, exact: Boolean(credentialId) })
}

/**
 * Forget exactly one reading (an account's, or the provider-wide one when no
 * `credentialId`) and its block, leaving every other account's untouched.
 * For a sign-in that was just renewed.
 */
export function forgetProviderUsageKey(client: QueryClient, providerId: string, credentialId?: string): void {
  const key = queryKeys.settings.providerUsage(providerId, credentialId)
  releaseBlock(client, key)
  client.removeQueries({ queryKey: key, exact: true })
}

/** A failed read's last-good snapshot, kept under its original time unless newer data is already held. */
export function seedLastGood(client: QueryClient, key: QueryKey, error: ProviderUsageError): void {
  const snapshot = error.lastGood
  if (!snapshot || error.kind === 'credentials' || typeof snapshot.updated_at !== 'number') return
  const at = snapshotUpdatedAtMs(snapshot, Date.now())
  const held = client.getQueryState<ProviderUsageResponse>(key)
  if (held?.data && held.dataUpdatedAt >= at) return
  client.setQueryData<ProviderUsageResponse>(key, snapshot, { updatedAt: at })
}
