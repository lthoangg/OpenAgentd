/**
 * TerminalFindBar — find in the terminal's scrollback (⌘F / Ctrl+Shift+F).
 *
 * A small bar over the top-right of the terminal, like TranscriptFind: type
 * to highlight every match, Enter / Shift+Enter (or the arrows) to step,
 * Escape to close. ``search`` is xterm's SearchAddon; its result events give
 * the "3 of 12" count, which needs the decoration options.
 */
import { useEffect, useRef, useState, type KeyboardEvent } from 'react'
import { CaseSensitive, ChevronDown, ChevronUp, X } from 'lucide-react'

import { cn } from '@/lib/utils'
import { formatMatchStatus, searchDecorations, type TerminalSearch } from './terminal-search'
import type { TerminalResolvedTheme } from './terminal-themes'

interface TerminalFindBarProps {
  search: TerminalSearch
  theme: TerminalResolvedTheme
  onClose: () => void
  /** Query to start from, e.g. the terminal's current selection. */
  initialQuery?: string
  /** Bump to move focus back into the input (find pressed while already open). */
  focusSignal?: number
}

const iconButton = 'flex size-7 shrink-0 items-center justify-center rounded-sm text-(--color-text-muted) hover:bg-(--bg-key) hover:text-(--color-text) disabled:opacity-40 pointer-coarse:size-9'

export function TerminalFindBar({ search, theme, onClose, initialQuery = '', focusSignal = 0 }: TerminalFindBarProps) {
  const inputRef = useRef<HTMLInputElement>(null)
  const [query, setQuery] = useState(initialQuery)
  const [caseSensitive, setCaseSensitive] = useState(false)
  const [results, setResults] = useState({ index: -1, count: 0 })

  useEffect(() => {
    inputRef.current?.focus()
    inputRef.current?.select()
  }, [focusSignal])

  useEffect(() => {
    const subscription = search.onDidChangeResults(({ resultIndex, resultCount }) => {
      setResults({ index: resultIndex, count: resultCount })
    })
    return () => {
      subscription.dispose()
      search.clearDecorations()
    }
  }, [search])

  const options = (incremental: boolean, matchCase = caseSensitive) => ({
    caseSensitive: matchCase,
    incremental,
    decorations: searchDecorations(theme),
  })

  const run = (next: string, matchCase: boolean) => {
    if (next === '') {
      search.clearDecorations()
      setResults({ index: -1, count: 0 })
      return
    }
    search.findNext(next, options(true, matchCase))
  }

  // A seed query (the selection) searches straight away, once per search addon.
  const seedRef = useRef({ query: initialQuery, theme })
  useEffect(() => {
    const { query: seed, theme: seedTheme } = seedRef.current
    if (seed) search.findNext(seed, { caseSensitive: false, incremental: true, decorations: searchDecorations(seedTheme) })
  }, [search])

  const step = (backwards: boolean) => {
    if (query === '') return
    if (backwards) search.findPrevious(query, options(false))
    else search.findNext(query, options(false))
  }

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter') {
      event.preventDefault()
      step(event.shiftKey)
    } else if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      onClose()
    }
  }

  const status = formatMatchStatus(query, results.index, results.count)
  const empty = query === ''

  return (
    <div
      role="search"
      aria-label="Find in terminal"
      className="flex items-center gap-1 rounded-md border border-(--color-border-subtle) bg-(--bg-card) py-1 pl-2 pr-1 shadow-(--shadow-depth)"
    >
      <input
        ref={inputRef}
        type="search"
        value={query}
        onChange={(event) => {
          setQuery(event.target.value)
          run(event.target.value, caseSensitive)
        }}
        onKeyDown={onKeyDown}
        placeholder="Find in terminal"
        aria-label="Find in terminal"
        autoComplete="off"
        spellCheck={false}
        className="h-7 w-40 bg-transparent text-sm text-(--color-text) placeholder-(--color-text-muted) outline-none pointer-coarse:h-9"
      />
      <span role="status" className={cn('min-w-16 text-right font-mono text-meta tabular-nums text-(--color-text-muted)', !status && 'invisible')}>
        {status}
      </span>
      <button
        type="button"
        className={cn(iconButton, caseSensitive && 'bg-(--bg-key) text-(--color-text)')}
        aria-label="Match case"
        aria-pressed={caseSensitive}
        onClick={() => {
          setCaseSensitive(!caseSensitive)
          run(query, !caseSensitive)
        }}
      >
        <CaseSensitive size={15} aria-hidden="true" />
      </button>
      <button type="button" className={iconButton} onClick={() => step(true)} disabled={empty} aria-label="Previous match (Shift+Enter)">
        <ChevronUp size={14} aria-hidden="true" />
      </button>
      <button type="button" className={iconButton} onClick={() => step(false)} disabled={empty} aria-label="Next match (Enter)">
        <ChevronDown size={14} aria-hidden="true" />
      </button>
      <button type="button" className={iconButton} onClick={onClose} aria-label="Close find">
        <X size={13} aria-hidden="true" />
      </button>
    </div>
  )
}
