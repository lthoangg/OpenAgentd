/**
 * TranscriptFind — find in session (⌘F from the chat).
 *
 * A small bar at the top of the chat column, like an editor's find widget:
 * type to count the matches in the transcript on screen, Enter / Shift+Enter
 * (or the arrows) to step through them, Escape to close. Matches are painted
 * with the CSS Custom Highlight API where the engine has it, so the
 * transcript's DOM is never touched; elsewhere the current match is scrolled
 * to only. Earlier turns that are not loaded are not searched.
 */
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import { ChevronDown, ChevronUp, X } from 'lucide-react'

import { cn } from '@/lib/utils'

const MAX_MATCHES = 1000
const HIGHLIGHT_ALL = 'oa-find'
const HIGHLIGHT_CURRENT = 'oa-find-current'

interface HighlightRegistry {
  set: (name: string, value: unknown) => void
  delete: (name: string) => void
}

function highlights(): HighlightRegistry | null {
  const css = (globalThis as { CSS?: { highlights?: HighlightRegistry } }).CSS
  const Ctor = (globalThis as { Highlight?: unknown }).Highlight
  return css?.highlights && typeof Ctor === 'function' ? css.highlights : null
}

function makeHighlight(ranges: Range[]): unknown {
  const Ctor = (globalThis as unknown as { Highlight: new (...ranges: Range[]) => unknown }).Highlight
  return new Ctor(...ranges)
}

/** Every case-insensitive occurrence of ``query`` in ``root``'s text. */
export function findRanges(root: Element, query: string): Range[] {
  const needle = query.toLowerCase()
  if (!needle) return []
  const ranges: Range[] = []
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: (node) => (node.parentElement?.closest('[data-find-skip], script, style') ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
  })
  for (let node = walker.nextNode(); node && ranges.length < MAX_MATCHES; node = walker.nextNode()) {
    const text = (node.nodeValue ?? '').toLowerCase()
    for (let at = text.indexOf(needle); at >= 0 && ranges.length < MAX_MATCHES; at = text.indexOf(needle, at + needle.length)) {
      const range = document.createRange()
      range.setStart(node, at)
      range.setEnd(node, at + needle.length)
      ranges.push(range)
    }
  }
  return ranges
}

function transcriptRoot(): Element | null {
  return document.querySelector('#main .oa-chat-scroll')
}

export function TranscriptFind({ onClose }: { onClose: () => void }) {
  const inputRef = useRef<HTMLInputElement>(null)
  const [query, setQuery] = useState('')
  const [current, setCurrent] = useState(0)
  // Bumped when the transcript changes under an open bar (a streaming turn).
  const [revision, setRevision] = useState(0)

  useEffect(() => {
    inputRef.current?.focus()
    inputRef.current?.select()
  }, [])

  useEffect(() => {
    const root = transcriptRoot()
    if (!root || typeof MutationObserver === 'undefined') return
    let timer = 0
    const observer = new MutationObserver(() => {
      window.clearTimeout(timer)
      timer = window.setTimeout(() => setRevision((value) => value + 1), 250)
    })
    observer.observe(root, { subtree: true, childList: true, characterData: true })
    return () => {
      observer.disconnect()
      window.clearTimeout(timer)
    }
  }, [])

  const ranges = useMemo(() => {
    // ``revision`` re-runs the search when the transcript changes.
    void revision
    const root = transcriptRoot()
    return root ? findRanges(root, query) : []
  }, [query, revision])
  const count = ranges.length
  const index = count === 0 ? 0 : Math.min(current, count - 1)

  useEffect(() => {
    const registry = highlights()
    const range = ranges[index]
    if (registry) {
      registry.set(HIGHLIGHT_ALL, makeHighlight(ranges))
      registry.set(HIGHLIGHT_CURRENT, makeHighlight(range ? [range] : []))
    }
    range?.startContainer.parentElement?.scrollIntoView?.({ block: 'center' })
  }, [ranges, index])
  useEffect(() => () => {
    const registry = highlights()
    registry?.delete(HIGHLIGHT_ALL)
    registry?.delete(HIGHLIGHT_CURRENT)
  }, [])

  const step = (delta: number) => {
    if (count === 0) return
    setCurrent((index + delta + count) % count)
  }

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter') {
      event.preventDefault()
      step(event.shiftKey ? -1 : 1)
    } else if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      onClose()
    }
  }

  const status = query === '' ? '' : count === 0 ? 'No results' : `${index + 1} of ${count}${count >= MAX_MATCHES ? '+' : ''}`
  const iconButton = 'flex size-7 shrink-0 items-center justify-center rounded-sm text-(--color-text-muted) hover:bg-(--bg-key) hover:text-(--color-text) disabled:opacity-40 pointer-coarse:size-9'

  return (
    <div
      role="search"
      aria-label="Find in session"
      data-find-skip=""
      className="absolute right-4 top-2 z-20 flex items-center gap-1 rounded-md border border-(--color-border-subtle) bg-(--bg-card) py-1 pl-2 pr-1 shadow-(--shadow-depth)"
    >
      <input
        ref={inputRef}
        type="search"
        value={query}
        onChange={(event) => { setQuery(event.target.value); setCurrent(0) }}
        onKeyDown={onKeyDown}
        placeholder="Find in session"
        aria-label="Find in session"
        autoComplete="off"
        spellCheck={false}
        className="h-7 w-48 bg-transparent text-sm text-(--color-text) placeholder-(--color-text-subtle) outline-none"
      />
      <span role="status" className={cn('min-w-16 text-right font-mono text-meta tabular-nums text-(--color-text-muted)', !status && 'invisible')}>
        {status}
      </span>
      <button type="button" className={iconButton} onClick={() => step(-1)} disabled={count === 0} aria-label="Previous match (Shift+Enter)">
        <ChevronUp size={14} aria-hidden="true" />
      </button>
      <button type="button" className={iconButton} onClick={() => step(1)} disabled={count === 0} aria-label="Next match (Enter)">
        <ChevronDown size={14} aria-hidden="true" />
      </button>
      <button type="button" className={iconButton} onClick={onClose} aria-label="Close find">
        <X size={13} aria-hidden="true" />
      </button>
    </div>
  )
}
