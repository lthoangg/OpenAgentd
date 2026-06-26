import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { ChevronDown } from 'lucide-react'
import fuzzysort from 'fuzzysort'

import { Input } from '@/components/ui/input'
import { cn } from '@/lib/utils'

export interface ModelOption {
  id: string
  provider: string
  model: string
  vision: boolean
  output_image?: boolean
  output_video?: boolean
}

/**
 * Typeahead combobox for picking a registry model id (``provider:model``).
 *
 * The user types into a regular text input; matches from the registry are
 * ranked by ``fuzzysort`` and rendered in a floating list below. Picking
 * an entry (click, ↑/↓ + Enter) commits the value. Free-text values that
 * don't match a registry entry are flagged by ``validateModel`` upstream
 * — the input itself doesn't gate keystrokes so the user can edit freely.
 *
 * Empty input commits an empty string, which the caller may interpret as
 * "unset".
 */
export function ModelCombobox({
  value,
  onChange,
  options,
  disabled,
  invalid,
  placeholder,
}: {
  value: string
  onChange: (v: string) => void
  options: ModelOption[]
  disabled?: boolean
  invalid?: boolean
  placeholder?: string
}) {
  const [query, setQuery] = useState(value)
  const [open, setOpen] = useState(false)
  const [highlight, setHighlight] = useState(0)
  const [anchorRect, setAnchorRect] = useState<DOMRect | null>(null)
  const wrapperRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLUListElement>(null)

  // Adopt external value changes (e.g. switching agents) without losing
  // the user's in-progress query while focused.
  const [lastValue, setLastValue] = useState(value)
  if (value !== lastValue) {
    setLastValue(value)
    setQuery(value)
  }

  // Track the input's viewport rect while the dropdown is open so the
  // portalled list stays pinned beneath it as the page scrolls or the
  // window resizes. Measured synchronously after layout so the first
  // frame after open is already positioned correctly.
  useLayoutEffect(() => {
    if (!open) return
    const measure = () => {
      const rect = inputRef.current?.getBoundingClientRect()
      if (rect) setAnchorRect(rect)
    }
    measure()
    window.addEventListener('scroll', measure, true)
    window.addEventListener('resize', measure)
    return () => {
      window.removeEventListener('scroll', measure, true)
      window.removeEventListener('resize', measure)
    }
  }, [open])

  // Close when a click/focus lands outside the input *and* the dropdown.
  // The portalled list isn't a DOM descendant of the wrapper, so we
  // can't rely on a single onBlur handler.
  useEffect(() => {
    if (!open) return
    const onPointerDown = (e: PointerEvent) => {
      const target = e.target as Node | null
      if (
        wrapperRef.current?.contains(target) ||
        listRef.current?.contains(target)
      ) {
        return
      }
      setOpen(false)
    }
    document.addEventListener('pointerdown', onPointerDown)
    return () => document.removeEventListener('pointerdown', onPointerDown)
  }, [open])

  // Filter + rank with fuzzysort. Empty query → full list (provider order).
  const filtered = useMemo<ModelOption[]>(() => {
    const q = query.trim()
    if (!q) return options
    // Indexing into ``id`` (the qualified ``provider:model``) means
    // searching ``gpt5`` and ``openai:gpt-5.4`` both work.
    const results = fuzzysort.go(q, options, {
      key: 'id',
      threshold: 0.2,
      limit: 50,
    })
    return results.map((r) => r.obj)
  }, [options, query])

  // Clamp highlight when the list shrinks. Derived-state pattern (see
  // React docs: "You might not need an effect").
  const [lastLen, setLastLen] = useState(filtered.length)
  if (lastLen !== filtered.length) {
    setLastLen(filtered.length)
    setHighlight((h) => Math.min(h, Math.max(filtered.length - 1, 0)))
  }

  const commit = (next: string) => {
    setQuery(next)
    onChange(next)
    setOpen(false)
  }

  const handleKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setOpen(true)
      setHighlight((i) => Math.min(i + 1, filtered.length - 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setHighlight((i) => Math.max(i - 1, 0))
    } else if (e.key === 'Enter') {
      if (!open) return
      e.preventDefault()
      const row = filtered[highlight]
      if (row) commit(row.id)
    } else if (e.key === 'Escape') {
      if (!open) return
      e.preventDefault()
      setOpen(false)
    }
  }

  return (
    <div ref={wrapperRef} className="relative">
      <div className="relative">
        <Input
          ref={inputRef}
          type="text"
          role="combobox"
          aria-expanded={open}
          aria-autocomplete="list"
          aria-controls="model-combobox-list"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value)
            setHighlight(0)
            setOpen(true)
            // Push the in-progress query upstream so validation surfaces
            // "Not in the provider model list" as the user types past a
            // known entry. Empty query commits an empty value.
            onChange(e.target.value)
          }}
          onFocus={() => setOpen(true)}
          onKeyDown={handleKey}
          disabled={disabled}
          placeholder={placeholder ?? 'Type to search models…'}
          aria-invalid={invalid || undefined}
          autoComplete="off"
          spellCheck={false}
          className="min-h-11 pr-9 font-mono md:min-h-9"
        />
        <button
          type="button"
          tabIndex={-1}
          aria-label={open ? 'Close model list' : 'Open model list'}
          onMouseDown={(e) => {
            // Toggle without stealing focus from the input.
            e.preventDefault()
            setOpen((v) => !v)
            inputRef.current?.focus()
          }}
          disabled={disabled}
          className="absolute top-1/2 right-1 flex h-7 w-7 -translate-y-1/2 items-center justify-center rounded text-(--color-text-muted) transition-colors hover:text-(--color-text) disabled:opacity-50"
        >
          <ChevronDown size={14} aria-hidden="true" />
        </button>
      </div>

      {open && !disabled && anchorRect &&
        createPortal(
          <ul
            ref={listRef}
            id="model-combobox-list"
            role="listbox"
            // Portalled to document.body so the dropdown escapes any
            // ancestor with ``overflow-hidden`` (e.g. the Card primitive).
            // Positioned in viewport coords via the tracked anchor rect.
            style={{
              position: 'fixed',
              top: anchorRect.bottom + 4,
              left: anchorRect.left,
              width: anchorRect.width,
            }}
            className="z-50 max-h-64 overflow-y-auto overscroll-contain rounded border border-(--color-border) bg-(--bg-card) p-1 shadow-md"
          >
            {filtered.length === 0 ? (
              <li className="px-3 py-3 text-center text-xs text-(--color-text-muted)">
                No matching models
              </li>
            ) : (
              filtered.map((o, i) => {
                const isHi = i === highlight
                const isSel = o.id === value
                return (
                  <li key={o.id}>
                    <button
                      type="button"
                      role="option"
                      aria-selected={isSel}
                      onMouseDown={(e) => e.preventDefault()}
                      onClick={() => commit(o.id)}
                      onMouseEnter={() => setHighlight(i)}
                      className={cn(
                        'flex w-full items-center justify-between gap-2 rounded px-2 py-1 text-left font-mono text-xs transition-colors cursor-pointer',
                        isHi ? 'bg-(--bg-key)' : '',
                        isSel ? 'text-(--color-text)' : 'text-(--color-text-2)',
                      )}
                    >
                      <span className="min-w-0 truncate">{o.id}</span>
                      {o.vision && (
                        <span className="shrink-0 text-[10px] text-(--color-text-muted)">
                          vision
                        </span>
                      )}
                    </button>
                  </li>
                )
              })
            )}
          </ul>,
          document.body,
        )}
    </div>
  )
}

// ── Field wrapper ───────────────────────────────────────────────────────────
