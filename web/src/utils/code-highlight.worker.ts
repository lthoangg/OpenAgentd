/**
 * Highlights large files off the main thread (see ``highlight-async.ts``).
 * Same ``highlightLines`` as the sync path, so results are identical.
 */
import { highlightLines } from './code-highlight'

// Typed loosely: a `webworker` lib reference would leak worker globals into
// the whole app's type check.
const scope = self as unknown as { onmessage: ((event: MessageEvent<{ id: number; code: string; lang?: string }>) => void) | null; postMessage: (message: unknown) => void }

scope.onmessage = (event) => {
  const { id, code, lang } = event.data
  let lines: string[] | null = null
  try {
    lines = highlightLines(code, lang)
  } catch {
    lines = null
  }
  scope.postMessage({ id, lines })
}
