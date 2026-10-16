/**
 * Asynchronous whole-file highlighting for the file viewer.
 *
 * Tokenizing is linear but slow on big files (~575 ms for a 512 kB TSX file,
 * ~14 ms at 64 kB), and the grammars match multi-line constructs across the
 * whole input, so it cannot be split into independent chunks. Large files are
 * therefore tokenized in one lazily created Web Worker while the viewer shows
 * plain lines. Without Worker support (tests, old webviews) it falls back to
 * the synchronous highlighter on a later task.
 */
import { highlightLines } from './code-highlight'

/** Files up to this size are highlighted synchronously, as before. */
export const SYNC_HIGHLIGHT_BYTES = 64 * 1024

type Pending = { resolve: (lines: string[]) => void; code: string; lang?: string }

let worker: Worker | null | undefined
let nextId = 1
const pending = new Map<number, Pending>()

function fallback(code: string, lang?: string): Promise<string[]> {
  return new Promise((resolve) => setTimeout(() => resolve(highlightLines(code, lang)), 0))
}

function getWorker(): Worker | null {
  if (worker !== undefined) return worker
  try {
    if (typeof Worker === 'undefined') throw new Error('no Worker')
    worker = new Worker(new URL('./code-highlight.worker.ts', import.meta.url), { type: 'module' })
    worker.onmessage = (event: MessageEvent<{ id: number; lines: string[] | null }>) => {
      const p = pending.get(event.data.id)
      if (!p) return
      pending.delete(event.data.id)
      if (event.data.lines) p.resolve(event.data.lines)
      else void fallback(p.code, p.lang).then(p.resolve)
    }
    worker.onerror = () => {
      // A worker that cannot load (CSP, bundling) is retired for good; every
      // waiting request finishes on the main thread instead.
      worker?.terminate()
      worker = null
      for (const [id, p] of pending) {
        pending.delete(id)
        void fallback(p.code, p.lang).then(p.resolve)
      }
    }
  } catch {
    worker = null
  }
  return worker
}

/** ``highlightLines`` off the main thread when possible. */
export function highlightLinesAsync(code: string, lang?: string): Promise<string[]> {
  const w = getWorker()
  if (!w) return fallback(code, lang)
  return new Promise((resolve) => {
    const id = nextId++
    pending.set(id, { resolve, code, lang })
    w.postMessage({ id, code, lang })
  })
}

const ESCAPES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }

/**
 * Unhighlighted lines in ``highlightLines``'s shape (one HTML-escaped string
 * per ``split('\n')`` line), shown until the highlighted ones arrive.
 */
export function plainLines(code: string): string[] {
  return code.split('\n').map((line) => line.replace(/[&<>"']/g, (c) => ESCAPES[c]))
}
