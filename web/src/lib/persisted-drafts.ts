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
 * Not window-scoped: two windows on the same session share a draft. Another
 * window's write arrives as a `storage` event; the map takes it in (unless
 * this window holds a newer write it has not saved yet) and tells
 * `subscribe` listeners which keys changed, so a composer in the background
 * window can show what is being typed in the other one.
 */

const WRITE_DELAY_MS = 250

export interface PersistedDraftMap<T> {
  get(key: string): T | undefined
  set(key: string, value: T): void
  delete(key: string): void
  clear(): void
  /** Hear about drafts another window changed (``undefined``: it was cleared). */
  subscribe(listener: (key: string, value: T | undefined) => void): () => void
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

function parsePairs<T>(raw: string | null): Map<string, T> {
  const out = new Map<string, T>()
  try {
    const parsed: unknown = raw ? JSON.parse(raw) : []
    if (Array.isArray(parsed)) {
      for (const pair of parsed) {
        if (Array.isArray(pair) && pair.length === 2 && typeof pair[0] === 'string') out.set(pair[0], pair[1] as T)
      }
    }
  } catch {
    // Corrupt or unreadable: nothing.
  }
  return out
}

function sameJson(a: unknown, b: unknown): boolean {
  try {
    return JSON.stringify(a) === JSON.stringify(b)
  } catch {
    return false
  }
}

export function createPersistedDraftMap<T>({ storageKey, max, maxBytesPerEntry = 200_000 }: PersistedDraftOptions): PersistedDraftMap<T> {
  let entries: Map<string, T> | null = null
  /** Keys too large to persist (still kept in memory). */
  const memoryOnly = new Set<string>()
  /** Keys written here since the last save: newer than anything another window sends. */
  const unsaved = new Set<string>()
  const listeners = new Set<(key: string, value: T | undefined) => void>()
  let timer: ReturnType<typeof setTimeout> | null = null
  let listening = false

  const load = (): Map<string, T> => {
    if (entries) return entries
    let raw: string | null = null
    try {
      raw = storage()?.getItem(storageKey) ?? null
    } catch {
      // Unreadable: start empty.
    }
    entries = parsePairs<T>(raw)
    // From the first use on, another window's saves keep this copy current.
    if (typeof window !== 'undefined') window.addEventListener('storage', onStorage)
    return entries
  }

  const flush = () => {
    if (timer !== null) {
      clearTimeout(timer)
      timer = null
    }
    unsaved.clear()
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

  // Another window saved: take its drafts in, key by key.
  const onStorage = (event: StorageEvent) => {
    if (event.key !== storageKey) return
    const map = load()
    const theirs = parsePairs<T>(event.newValue)
    const keys = new Set([...map.keys(), ...theirs.keys()])
    for (const key of keys) {
      if (unsaved.has(key) || memoryOnly.has(key)) continue
      const next = theirs.get(key)
      if (sameJson(map.get(key), next)) continue
      if (next === undefined) map.delete(key)
      else map.set(key, next)
      for (const listener of listeners) listener(key, next)
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
      unsaved.add(key)
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
      unsaved.add(key)
      schedule()
    },
    clear: () => {
      entries = new Map()
      memoryOnly.clear()
      flush()
    },
    subscribe: (listener) => {
      load()
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
  }
}
