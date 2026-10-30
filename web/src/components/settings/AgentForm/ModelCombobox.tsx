import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { X } from 'lucide-react'
import fuzzysort from 'fuzzysort'

import { Input } from '@/components/ui/input'
import { MENU_ITEM_CLASS, MENU_PANEL_CLASS } from '@/components/ui/menu-styles'
import { cn } from '@/lib/utils'
import { Chip } from '@/components/ui/chip'
import { getVisibleViewport, onVisibleViewportChange, type VisibleViewport } from '@/lib/visible-viewport'
import { hoverIntent } from '@/hooks/use-hover-intent'

/** Tallest the list grows (Tailwind ``max-h-64``). */
const LIST_MAX_HEIGHT = 256
const LIST_MIN_HEIGHT = 96
const LIST_GAP = 4
const LIST_MARGIN = 8

/**
 * Where the list goes: below the input when it fits in the visible area,
 * otherwise above it when there is more room there (the iOS keyboard covers
 * the bottom). The height is capped to the room on the chosen side.
 */
export function listPlacement(anchor: DOMRect, visible: VisibleViewport): { above: boolean; maxHeight: number } {
  const below = visible.bottom - anchor.bottom - LIST_GAP - LIST_MARGIN
  const above = anchor.top - visible.top - LIST_GAP - LIST_MARGIN
  const flip = below < LIST_MAX_HEIGHT && above > below
  // Never collapse to nothing: a few rows beat an empty list.
  return { above: flip, maxHeight: Math.max(LIST_MIN_HEIGHT, Math.min(LIST_MAX_HEIGHT, flip ? above : below)) }
}

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
 *
 * The list is portalled to `document.body`, which puts it outside any modal
 * focus trap, so focus stays on the input and the highlighted row is published
 * via `aria-activedescendant`. Escape is consumed while the list is open so
 * dismissing the list never closes an enclosing modal.
 */
export function ModelCombobox({
  value,
  onChange,
  options,
  disabled,
  invalid,
  placeholder,
  ariaLabel,
  inputRef: externalInputRef,
  openOnFocus = true,
}: {
  value: string
  onChange: (v: string) => void
  options: ModelOption[]
  disabled?: boolean
  invalid?: boolean
  placeholder?: string
  /** Accessible name for the input when no visible <label> is associated. */
  ariaLabel?: string
  /** Exposes the input so a parent can focus it (e.g. modal initial focus). */
  inputRef?: React.RefObject<HTMLInputElement | null>
  /**
   * Whether merely receiving focus opens the list. Turn this off where the
   * input is focused programmatically on mount, otherwise the panel greets the
   * user with a list covering everything below it. Clicking, typing and
   * ArrowDown still open it.
   */
  openOnFocus?: boolean
}) {
  const uid = useId()
  const listId = `model-combobox-list-${uid}`
  const [query, setQuery] = useState(value)
  const [open, setOpen] = useState(false)
  const [highlight, setHighlight] = useState(0)
  const [anchorRect, setAnchorRect] = useState<DOMRect | null>(null)
  // The visible area at the last measure: on iOS the soft keyboard covers the
  // bottom of the screen, so the list flips above the input when it would not
  // fit below.
  const [visible, setVisible] = useState<VisibleViewport | null>(null)
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
      setVisible(getVisibleViewport())
    }
    measure()
    window.addEventListener('scroll', measure, true)
    const stopViewport = onVisibleViewportChange(measure)
    return () => {
      window.removeEventListener('scroll', measure, true)
      stopViewport()
    }
  }, [open])

  const placement = anchorRect && visible ? listPlacement(anchorRect, visible) : null

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
      // Without this, a modal listening for Escape on document would close at
      // the same time as the list.
      e.stopPropagation()
      setOpen(false)
    }
  }

  return (
    <div ref={wrapperRef} className="relative">
      <div className="relative">
        <Input
          ref={(node) => {
            inputRef.current = node
            if (externalInputRef) externalInputRef.current = node
          }}
          type="text"
          role="combobox"
          aria-expanded={open}
          aria-autocomplete="list"
          aria-controls={listId}
          aria-activedescendant={
            open && filtered.length > 0 ? `${listId}-option-${highlight}` : undefined
          }
          aria-label={ariaLabel}
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
          onFocus={() => { if (openOnFocus) setOpen(true) }}
          // Pointer interaction always opens, independent of openOnFocus, so a
          // click on the field behaves the way a click on a select does.
          onClick={() => setOpen(true)}
          onKeyDown={handleKey}
          disabled={disabled}
          placeholder={placeholder ?? 'Type to search models…'}
          aria-invalid={invalid || undefined}
          autoComplete="off"
          spellCheck={false}
          className="min-h-9 pr-9 font-mono pointer-coarse:min-h-9 pointer-coarse:pr-11"
        />
        {query && (
          <button
            type="button"
            tabIndex={-1}
            aria-label="Clear model"
            onMouseDown={(e) => {
              // preventDefault keeps focus on the input (no blur/refocus cycle).
              // Since the input stays focused, onFocus never re-fires, so we
              // must explicitly reopen the dropdown after clearing.
              e.preventDefault()
              setQuery('')
              onChange('')
              setHighlight(0)
              setOpen(true)
            }}
            disabled={disabled}
            className="absolute top-1/2 right-1 flex h-9 w-9 -translate-y-1/2 items-center justify-center rounded-sm text-(--color-text-muted) transition-colors hover:text-(--color-text) disabled:opacity-50 md:h-7 md:w-7 pointer-coarse:size-9"
          >
            <X size={13} aria-hidden="true" />
          </button>
        )}
      </div>

      {open && !disabled && anchorRect &&
        createPortal(
          <ul
            ref={listRef}
            id={listId}
            role="listbox"
            // Portalled to document.body so the dropdown escapes any
            // ancestor with ``overflow-hidden`` (e.g. the Card primitive).
            // Positioned in viewport coords via the tracked anchor rect.
            style={{
              position: 'fixed',
              ...(placement?.above
                ? { bottom: window.innerHeight - anchorRect.top + LIST_GAP }
                : { top: anchorRect.bottom + LIST_GAP }),
              left: anchorRect.left,
              width: anchorRect.width,
              ...(placement && placement.maxHeight < LIST_MAX_HEIGHT ? { maxHeight: placement.maxHeight } : null),
            }}
            className={cn(
              'z-50 max-h-64 overflow-y-auto overscroll-contain',
              MENU_PANEL_CLASS,
              // DESIGN.md → Motion: grows out of the field like Dropdown. It
              // closes at once: a pick or a blur should feel immediate.
              'animate-in fade-in-0 zoom-in-95 animation-duration-(--motion-base) ease-(--ease-out)',
              placement?.above ? 'origin-bottom' : 'origin-top',
            )}
          >
            {filtered.length === 0 ? (
              <li className="px-3 py-3 text-center text-xs text-(--color-text-muted)">
                No matching models
              </li>
            ) : (
              filtered.flatMap((o, i) => {
                const isHi = i === highlight
                const isSel = o.id === value
                // Group under a provider heading while the list is in provider
                // order (no query); ranked results stay flat.
                const showHeading = !query.trim() && (i === 0 || filtered[i - 1].provider !== o.provider)
                const row = (
                  <li key={o.id}>
                    <button
                      type="button"
                      id={`${listId}-option-${i}`}
                      role="option"
                      aria-selected={isSel}
                      tabIndex={-1}
                      onMouseDown={(e) => e.preventDefault()}
                      onClick={() => commit(o.id)}
                      {...hoverIntent(() => setHighlight(i))}
                      className={cn(
                        MENU_ITEM_CLASS,
                        'justify-between gap-2 transition-colors',
                        isHi ? 'bg-(--bg-key)' : '',
                        isSel ? 'text-(--color-text)' : 'text-(--color-text-2)',
                      )}
                      title={o.id}
                    >
                      <span className="min-w-0 truncate font-mono">{o.model}</span>
                      <span className="flex shrink-0 items-center gap-1">
                        {o.vision && <Chip title="Accepts image input">Vision</Chip>}
                        {query.trim() && <Chip mono variant="outline">{o.provider}</Chip>}
                      </span>
                    </button>
                  </li>
                )
                return showHeading
                  ? [
                      <li key={`h:${o.provider}`} role="presentation" className="px-2.5 pt-2 pb-1 font-mono text-[11px] text-(--color-text-subtle) select-none">
                        {o.provider}
                      </li>,
                      row,
                    ]
                  : [row]
              })
            )}
          </ul>,
          document.body,
        )}
    </div>
  )
}

// ── Field wrapper ───────────────────────────────────────────────────────────
