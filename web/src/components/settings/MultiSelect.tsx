/**
 * MultiSelect — combobox-style multi-select built on the project's
 * shadcn Popover (which wraps `@base-ui/react`'s Popover primitive).
 *
 * Used for picking tools and skills in the agent editor.
 *
 *   • Selected values render as chips inside the trigger.
 *   • Clicking the trigger opens a popover with a search input + list.
 *   • Keyboard: type to filter, ↑/↓ to move, Enter to toggle, Esc to close.
 *   • Backspace on the search input (when empty) removes the last chip.
 *
 * The component preserves the previous public API (`options`, `value`,
 * `onChange`, `placeholder`, `emptyLabel`) so callers don't need to change.
 */
import { useMemo, useRef, useState } from 'react'
import { Check, ChevronDown, Search, X } from 'lucide-react'

import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { cn } from '@/lib/utils'

export interface MultiSelectOption {
  value: string
  label: string
  description?: string
}

interface Props {
  options: MultiSelectOption[]
  value: string[]
  onChange: (next: string[]) => void
  placeholder?: string
  emptyLabel?: string
  /** Optional id forwarded to the search input (for label association). */
  searchId?: string
}

export function MultiSelect({
  options,
  value,
  onChange,
  placeholder = 'Select…',
  emptyLabel = 'No matches',
  searchId,
}: Props) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [highlight, setHighlight] = useState(0)
  const searchRef = useRef<HTMLInputElement>(null)

  const selected = useMemo(() => new Set(value), [value])

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return options
    return options.filter(
      (o) =>
        o.value.toLowerCase().includes(q) ||
        o.label.toLowerCase().includes(q) ||
        o.description?.toLowerCase().includes(q),
    )
  }, [options, query])

  // Clamp highlight when the filtered list shrinks. Derived-state pattern:
  // track the last-seen length so we only correct on actual changes, never
  // on every render. (See React docs: "You might not need an effect".)
  const [lastFilteredLen, setLastFilteredLen] = useState(filtered.length)
  if (lastFilteredLen !== filtered.length) {
    setLastFilteredLen(filtered.length)
    setHighlight((h) => Math.min(h, Math.max(filtered.length - 1, 0)))
  }

  // Reset query + highlight when the popover closes so the next open
  // starts fresh. Tracked the same way as ``lastFilteredLen``.
  const [lastOpen, setLastOpen] = useState(open)
  if (lastOpen !== open) {
    setLastOpen(open)
    if (!open) {
      setQuery('')
      setHighlight(0)
    }
  }

  const toggle = (v: string) => {
    if (selected.has(v)) onChange(value.filter((x) => x !== v))
    else onChange([...value, v])
  }

  const remove = (v: string) => onChange(value.filter((x) => x !== v))

  const handleKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setHighlight((i) => Math.min(i + 1, filtered.length - 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setHighlight((i) => Math.max(i - 1, 0))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      const row = filtered[highlight]
      if (row) toggle(row.value)
    } else if (e.key === 'Escape') {
      e.preventDefault()
      setOpen(false)
    } else if (e.key === 'Backspace' && query === '' && value.length > 0) {
      e.preventDefault()
      remove(value[value.length - 1])
    }
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        nativeButton={false}
        // Render as a combobox div so selected chips can contain their own
        // remove buttons without nested <button> semantics.
        render={
          <div
            role="combobox"
            aria-expanded={open}
            aria-haspopup="listbox"
            tabIndex={0}
            className={cn(
              'flex min-h-11 w-full cursor-text flex-wrap items-center gap-1 rounded-lg border border-(--color-border) bg-(--bg-input) px-1.5 py-1 text-sm text-(--color-text) transition-colors outline-none md:min-h-8',
              'focus-visible:border-(--focus-ring) focus-visible:ring-3 focus-visible:ring-(--focus-ring)/50',
              'aria-expanded:border-(--focus-ring)',
            )}
          >
            {value.length === 0 && (
              <span className="px-1.5 text-(--color-text-muted)">{placeholder}</span>
            )}
            {value.map((v) => (
              <span
                key={v}
                className="flex items-center gap-1 rounded-sm bg-(--bg-key) px-1.5 py-0.5 font-mono text-xs text-(--color-text)"
              >
                {v}
                <button
                  type="button"
                  // Stop the surrounding-trigger click from re-toggling the
                  // popover when the user removes a chip.
                  onMouseDown={(e) => e.stopPropagation()}
                  onClick={(e) => {
                    e.preventDefault()
                    e.stopPropagation()
                    remove(v)
                  }}
                  aria-label={`Remove ${v}`}
                  className="flex h-7 w-7 items-center justify-center text-(--color-text-muted) transition-colors hover:text-(--color-text) md:h-auto md:w-auto"
                >
                  <X size={11} />
                </button>
              </span>
            ))}
            <ChevronDown
              size={14}
              className="ml-auto shrink-0 self-center text-(--color-text-muted)"
              aria-hidden="true"
            />
          </div>
        }
      />
      <PopoverContent
        align="start"
        sideOffset={4}
        className="w-[--anchor-width] min-w-72 max-w-[28rem] p-0"
      >
        <div className="flex items-center gap-2 border-b border-(--color-border) px-2.5 py-2">
          <Search size={13} className="shrink-0 text-(--color-text-muted)" aria-hidden="true" />
          <input
            id={searchId}
            ref={searchRef}
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={handleKey}
            placeholder="Search…"
            className="flex-1 bg-transparent text-sm text-(--color-text) outline-none placeholder:text-(--color-text-muted)"
            aria-label="Search options"
          />
          <span className="shrink-0 text-[11px] text-(--color-text-muted)">
            {filtered.length}/{options.length}
          </span>
        </div>
        <ul
          role="listbox"
          aria-multiselectable
          className="max-h-64 overflow-y-auto py-1"
        >
          {filtered.length === 0 ? (
            <li className="px-3 py-4 text-center text-sm text-(--color-text-muted)">
              {emptyLabel}
            </li>
          ) : (
            filtered.map((o, i) => {
              const isSel = selected.has(o.value)
              const isHi = i === highlight
              return (
                <li key={o.value}>
                  <button
                    type="button"
                    role="option"
                    aria-selected={isSel}
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => {
                      toggle(o.value)
                      // Keep focus + popover open for fast multi-pick.
                      searchRef.current?.focus()
                    }}
                    onMouseEnter={() => setHighlight(i)}
                    className={cn(
                      'flex min-h-11 w-full items-start gap-2 px-2.5 py-1.5 text-left transition-colors md:min-h-0',
                      isHi && 'bg-(--bg-key)',
                    )}
                  >
                    <span
                      className={cn(
                        'mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-sm border transition-colors',
                        isSel
                          ? 'border-(--color-text) bg-(--color-text) text-(--bg-page)'
                          : 'border-(--color-border) text-(--color-text)',
                      )}
                      aria-hidden="true"
                    >
                      {isSel && <Check size={10} strokeWidth={3} />}
                    </span>
                    <div className="min-w-0 flex-1">
                      <p className="truncate font-mono text-xs text-(--color-text)">
                        {o.label}
                      </p>
                      {o.description && (
                        <p className="truncate text-[11px] text-(--color-text-muted)">
                          {o.description}
                        </p>
                      )}
                    </div>
                  </button>
                </li>
              )
            })
          )}
        </ul>
      </PopoverContent>
    </Popover>
  )
}
