import { useEffect, useState } from 'react'
import { toolCallArguments, toolResult } from '@/api/client/tool-results'
import { useAgentStore } from '@/stores/useAgentStore'

const CACHE_MAX = 100

function keyOf(sessionId: string, toolCallId: string): string {
  return `${sessionId}\u0000${toolCallId}`
}

export interface RemoteTextState {
  /** The text, once here. */
  text: string | undefined
  loading: boolean
  error: string | null
}

/**
 * Text of a call in the open session that stays on the server until asked
 * for, cached by session and call: reopening a row costs nothing.
 */
function remoteText(load: (sessionId: string, toolCallId: string) => Promise<string>) {
  const cache = new Map<string, string>()
  const inflight = new Map<string, Promise<string>>()

  function fetchText(toolCallId: string): Promise<string> {
    const sessionId = useAgentStore.getState().sessionId
    if (!sessionId) return Promise.reject(new Error('No session'))
    const key = keyOf(sessionId, toolCallId)
    const hit = cache.get(key)
    if (hit !== undefined) return Promise.resolve(hit)
    const pending = inflight.get(key)
    if (pending) return pending
    const request = load(sessionId, toolCallId)
      .then((text) => {
        if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value as string)
        cache.set(key, text)
        return text
      })
      .finally(() => inflight.delete(key))
    inflight.set(key, request)
    return request
  }

  /** The text while ``wanted`` (the row is open); idle when it is not ``onServer``. */
  function useText(toolCallId: string | undefined, onServer: boolean, wanted: boolean): RemoteTextState {
    const sessionId = useAgentStore((s) => s.sessionId)
    const key = toolCallId && sessionId ? keyOf(sessionId, toolCallId) : null
    const [fetched, setFetched] = useState<{ key: string; text?: string; error?: string } | null>(null)
    const mine = fetched && fetched.key === key ? fetched : null
    const text = (key ? cache.get(key) : undefined) ?? mine?.text
    const needed = onServer && wanted && key !== null && text === undefined && !mine?.error
    useEffect(() => {
      if (!needed || !toolCallId || !key) return
      let live = true
      fetchText(toolCallId).then(
        (value) => { if (live) setFetched({ key, text: value }) },
        (err: unknown) => { if (live) setFetched({ key, error: err instanceof Error ? err.message : String(err) }) },
      )
      return () => { live = false }
    }, [needed, toolCallId, key])
    return { text, loading: needed, error: mine?.error ?? null }
  }

  const clear = () => {
    cache.clear()
    inflight.clear()
  }
  return { useText, clear }
}

/** Output history and ``tool_end`` left out (``toolResultBytes``). */
const results = remoteText((sessionId, toolCallId) => toolResult(sessionId, toolCallId).then((r) => r.content))
/** Arguments history sent short (``toolArgsBytes``). */
const callArguments = remoteText((sessionId, toolCallId) => toolCallArguments(sessionId, toolCallId).then((r) => r.arguments))

export function clearToolResultCache(): void {
  results.clear()
  callArguments.clear()
}

/** A call's output that stayed on the server, fetched while the row is open. */
export const useToolResult = results.useText
/** A call's full arguments when history sent them short, fetched while the row is open. */
export const useToolArguments = callArguments.useText
