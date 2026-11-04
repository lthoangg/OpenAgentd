import { useEffect, useState } from 'react'
import { toolResult } from '@/api/client/tool-results'
import { useAgentStore } from '@/stores/useAgentStore'

/** Fetched outputs by session and call: reopening a row costs nothing. */
const cache = new Map<string, string>()
const inflight = new Map<string, Promise<string>>()
const CACHE_MAX = 100

export function clearToolResultCache(): void {
  cache.clear()
  inflight.clear()
}

function keyOf(sessionId: string, toolCallId: string): string {
  return `${sessionId}\u0000${toolCallId}`
}

/** The output of a call in the open session, from the cache or the server. */
export function fetchToolResult(toolCallId: string): Promise<string> {
  const sessionId = useAgentStore.getState().sessionId
  if (!sessionId) return Promise.reject(new Error('No session'))
  const key = keyOf(sessionId, toolCallId)
  const hit = cache.get(key)
  if (hit !== undefined) return Promise.resolve(hit)
  const pending = inflight.get(key)
  if (pending) return pending
  const request = toolResult(sessionId, toolCallId)
    .then((r) => {
      if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value as string)
      cache.set(key, r.content)
      return r.content
    })
    .finally(() => inflight.delete(key))
  inflight.set(key, request)
  return request
}

export interface ToolResultState {
  /** The output, once here. */
  text: string | undefined
  loading: boolean
  error: string | null
}

/**
 * A call's output that stayed on the server (``toolResultBytes``), fetched
 * while ``wanted`` (the row is open). Idle when the result rode with the call.
 */
export function useToolResult(toolCallId: string | undefined, onServer: boolean, wanted: boolean): ToolResultState {
  const sessionId = useAgentStore((s) => s.sessionId)
  const key = toolCallId && sessionId ? keyOf(sessionId, toolCallId) : null
  const [fetched, setFetched] = useState<{ key: string; text?: string; error?: string } | null>(null)
  const mine = fetched && fetched.key === key ? fetched : null
  const text = (key ? cache.get(key) : undefined) ?? mine?.text
  const needed = onServer && wanted && key !== null && text === undefined && !mine?.error
  useEffect(() => {
    if (!needed || !toolCallId || !key) return
    let live = true
    fetchToolResult(toolCallId).then(
      (result) => { if (live) setFetched({ key, text: result }) },
      (err: unknown) => { if (live) setFetched({ key, error: err instanceof Error ? err.message : String(err) }) },
    )
    return () => { live = false }
  }, [needed, toolCallId, key])
  return { text, loading: needed, error: mine?.error ?? null }
}
