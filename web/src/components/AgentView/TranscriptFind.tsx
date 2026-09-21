import { useEffect, useRef } from 'react'
import { ChevronDown, ChevronUp, X } from 'lucide-react'

export interface TranscriptFindProps {
  query: string
  matchCount: number
  activeIndex: number
  onQueryChange: (query: string) => void
  onNext: () => void
  onPrev: () => void
  onClose: () => void
}

export function TranscriptFind({
  query,
  matchCount,
  activeIndex,
  onQueryChange,
  onNext,
  onPrev,
  onClose,
}: TranscriptFindProps) {
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    inputRef.current?.focus()
    inputRef.current?.select()
  }, [])

  const status = !query.trim()
    ? ''
    : matchCount === 0
      ? 'No matches'
      : `${activeIndex + 1}/${matchCount}`

  return (
    <div
      className="flex shrink-0 items-center gap-1.5 border-b border-(--color-border) bg-(--bg-page) px-3 py-1.5"
      role="search"
    >
      <input
        ref={inputRef}
        type="search"
        value={query}
        onChange={(event) => onQueryChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.preventDefault()
            onClose()
            return
          }
          if (event.key === 'Enter') {
            event.preventDefault()
            if (event.shiftKey) onPrev()
            else onNext()
          }
        }}
        placeholder="Find in transcript"
        aria-label="Find in transcript"
        className="min-w-0 flex-1 rounded-sm border border-(--color-border) bg-(--bg-input) px-2 py-1 text-xs text-(--color-text) outline-none placeholder:text-(--color-text-muted) focus:border-(--focus-ring) focus:ring-2 focus:ring-(--focus-ring)/30"
      />
      <span className="shrink-0 font-mono text-[11px] text-(--color-text-muted)" aria-live="polite">
        {status}
      </span>
      <button
        type="button"
        onClick={onPrev}
        disabled={matchCount === 0}
        aria-label="Previous match"
        className="flex h-6 w-6 items-center justify-center rounded-xs text-(--color-text-muted) hover:bg-(--bg-key) hover:text-(--color-text) disabled:opacity-40"
      >
        <ChevronUp size={13} aria-hidden="true" />
      </button>
      <button
        type="button"
        onClick={onNext}
        disabled={matchCount === 0}
        aria-label="Next match"
        className="flex h-6 w-6 items-center justify-center rounded-xs text-(--color-text-muted) hover:bg-(--bg-key) hover:text-(--color-text) disabled:opacity-40"
      >
        <ChevronDown size={13} aria-hidden="true" />
      </button>
      <button
        type="button"
        onClick={onClose}
        aria-label="Close find"
        className="flex h-6 w-6 items-center justify-center rounded-xs text-(--color-text-muted) hover:bg-(--bg-key) hover:text-(--color-text)"
      >
        <X size={13} aria-hidden="true" />
      </button>
    </div>
  )
}
