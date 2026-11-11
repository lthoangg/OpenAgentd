/**
 * SSE stream reader for fetch() responses.
 *
 * Wire format from backend (sse_starlette):
 *   event: <type>\n
 *   data: <json>\n
 *   \n
 *
 * Usage:
 *   const res = await fetch(url, { signal })
 *   readSSE(res, {
 *     onEvent: (type, data) => ...,
 *     onError: (err)        => ...,
 *     onDone:  ()           => ...,
 *   })
 */

export interface SSECallbacks {
  /** `id` is the event's SSE id, when the server sent one (global events). */
  onEvent: (type: string, data: unknown, id?: string) => void
  onError?: (err: Error) => void
  onParseError?: (err: Error) => void
  onDone?: () => void
}

export function readSSE(response: Response, callbacks: SSECallbacks): void {
  if (!response.body) {
    callbacks.onError?.(new Error('No response body'))
    return
  }

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  // Pieces of the line still waiting for its "\n". Kept as pieces so a long
  // `data:` line (a big tool result) arriving over many reads is scanned once,
  // not re-split from its start on every read.
  let partial: string[] = []

  // Current event fields being accumulated
  let currentEvent = ''
  let currentData = ''
  let currentId = ''

  const dispatchEvent = () => {
    if (!currentData) {
      currentId = ''
      return
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(currentData)
    } catch {
      callbacks.onParseError?.(new Error(`SSE parse error: ${currentData}`))
      currentEvent = ''
      currentData = ''
      currentId = ''
      return
    }
    const embeddedType = parsed && typeof parsed === 'object' && 'type' in parsed && typeof parsed.type === 'string'
      ? parsed.type : 'unknown'
    const type = currentEvent || embeddedType
    const id = currentId
    currentEvent = ''
    currentData = ''
    currentId = ''
    if (id) callbacks.onEvent(type, parsed, id)
    else callbacks.onEvent(type, parsed)
  }

  const processLine = (line: string) => {
    if (line === '') {
      // Empty line = event boundary — dispatch accumulated event
      dispatchEvent()
      return
    }
    if (line.startsWith('event:')) {
      currentEvent = line.slice(6).trim()
    } else if (line.startsWith('id:')) {
      currentId = line.slice(3).trim()
    } else if (line.startsWith('data:')) {
      const chunk = line.slice(5).trim()
      // Concatenate multi-line data (rare, but spec-compliant)
      currentData = currentData ? currentData + '\n' + chunk : chunk
    }
    // retry: lines are intentionally ignored
  }

  const pump = async () => {
    try {
      while (true) {
        const { done, value } = await reader.read()

        if (done) {
          // Flush any remaining buffer
          const remaining = partial.join('').trim()
          partial = []
          if (remaining) processLine(remaining)
          dispatchEvent()
          callbacks.onDone?.()
          return
        }

        const text = decoder.decode(value, { stream: true })
        let start = 0
        let newline = text.indexOf('\n')
        while (newline !== -1) {
          let line = text.slice(start, newline)
          if (partial.length > 0) {
            partial.push(line)
            line = partial.join('')
            partial = []
          }
          processLine(line.trimEnd())    // strip \r
          start = newline + 1
          newline = text.indexOf('\n', start)
        }
        if (start < text.length) partial.push(text.slice(start))
      }
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') return
      callbacks.onError?.(err instanceof Error ? err : new Error(String(err)))
    } finally {
      reader.releaseLock()
    }
  }

  pump()
}
