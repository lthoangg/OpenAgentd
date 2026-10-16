/**
 * Small LRU maps of typed-but-unsent text (composer prompts, ask-user answers,
 * plan-review comments) that survive a reload or a renderer crash.
 *
 * Reads come from memory; the map is hydrated from `localStorage` on first use
 * and written back debounced, plus synchronously when the page is hidden or
 * unloaded (the moments a crash or reload follows). Storage is best-effort:
 * quota errors, private mode, or corrupt JSON fall back to memory only, which
 * is the behaviour these drafts had before they were persisted.
 *
 * Not window-scoped: two windows on the same session share a draft, and the
 * last write wins.
 */

const WRITE_DELAY_MS = 250

export interface PersistedDraftMap<T> {
  get(key: string): T | undefined
  set(key: string, value: T): void
  delete(key: string): void
  clear(): void
}

export interface PersistedDraftOptions {
  storageKey: string
  /** Most entries kept; the least recently written are dropped first. */
  max: number
  /** Entries whose JSON is larger than this stay in memory only. */
  maxBytesPerEntry?: number
}

function storage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage
  } catch {
    return null
  }
}

export function createPersistedDraftMap<T>({ storageKey, max, maxBytesPerEntry = 200_000 }: PersistedDraftOptions): PersistedDraftMap<T> {
  let entries: Map<string, T> | null = null
  /** Keys too large to persist (still kept in memory). */
  const memoryOnly = new Set<string>()
  let timer: ReturnType<typeof setTimeout> | null = null
  let listening = false

  const load = (): Map<string, T> => {
    if (entries) return entries
    entries = new Map()
    try {
      const raw = storage()?.getItem(storageKey)
      const parsed: unknown = raw ? JSON.parse(raw) : []
      if (Array.isArray(parsed)) {
        for (const pair of parsed) {
          if (Array.isArray(pair) && pair.length === 2 && typeof pair[0] === 'string') entries.set(pair[0], pair[1] as T)
        }
      }
    } catch {
      // Corrupt or unreadable: start empty.
    }
    return entries
  }

  const flush = () => {
    if (timer !== null) {
      clearTimeout(timer)
      timer = null
    }
    if (!entries) return
    try {
      const pairs = [...entries].filter(([k]) => !memoryOnly.has(k))
      const s = storage()
      if (!s) return
      if (pairs.length === 0) s.removeItem(storageKey)
      else s.setItem(storageKey, JSON.stringify(pairs))
    } catch {
      // Quota or private mode: memory only.
    }
  }

  const schedule = () => {
    if (!listening && typeof window !== 'undefined') {
      listening = true
      window.addEventListener('pagehide', flush)
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'hidden') flush()
      })
    }
    if (timer !== null) clearTimeout(timer)
    timer = setTimeout(flush, WRITE_DELAY_MS)
  }

  return {
    get: (key) => load().get(key),
    set: (key, value) => {
      const map = load()
      map.delete(key)
      map.set(key, value)
      let size = 0
      try {
        size = JSON.stringify(value).length
      } catch {
        size = Infinity
      }
      if (size > maxBytesPerEntry) memoryOnly.add(key)
      else memoryOnly.delete(key)
      while (map.size > max) {
        const oldest = map.keys().next()
        if (oldest.done) break
        map.delete(oldest.value)
        memoryOnly.delete(oldest.value)
      }
      schedule()
    },
    delete: (key) => {
      const map = load()
      if (!map.delete(key)) return
      memoryOnly.delete(key)
      schedule()
    },
    clear: () => {
      entries = new Map()
      memoryOnly.clear()
      flush()
    },
  }
}
