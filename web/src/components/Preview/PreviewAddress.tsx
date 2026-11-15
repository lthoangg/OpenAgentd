/**
 * The Preview tab's address field. At rest it shows the address without
 * `http://`; focused, it shows the whole address and suggests the
 * workspace's recent addresses and its HTML pages.
 */
import { useEffect, useId, useMemo, useRef, useState } from 'react'
import { MENU_ITEM_CLASS, MENU_PANEL_CLASS } from '@/components/ui/menu-styles'
import { cn } from '@/lib/utils'
import { type AddressSuggestion, addressSuggestions, shortAddress } from './preview-suggestions'

const GROUP_TITLE: Record<AddressSuggestion['group'], string> = {
  recent: 'Recent',
  page: 'Pages in this workspace',
}

export function PreviewAddress({ url, phone, loading, recent, files, onSubmit, onEdit }: {
  /** The address the tab shows. */
  url: string
  phone: boolean
  /** A page is on its way: a sweep runs along the field's bottom edge. */
  loading: boolean
  /** Reads the workspace's recent addresses; asked each time the field is focused. */
  recent: () => string[]
  /** Workspace-relative file paths. */
  files: readonly string[]
  onSubmit: (raw: string) => void
  /** The text was edited: a message about the last address no longer applies. */
  onEdit: () => void
}) {
  const [draft, setDraft] = useState<string | null>(null)
  const [focused, setFocused] = useState(false)
  const [recentUrls, setRecentUrls] = useState<string[]>([])
  /** The suggestion the arrow keys are on, or -1 for the typed text. */
  const [active, setActive] = useState(-1)
  const inputRef = useRef<HTMLInputElement>(null)
  const listId = useId()

  // Focus swaps the short address for the whole one; select it once it is there.
  useEffect(() => {
    if (focused) inputRef.current?.select()
  }, [focused])

  const suggestions = useMemo(
    () => (focused ? addressSuggestions({ recent: recentUrls, files, query: draft ?? '', current: url }) : []),
    [focused, recentUrls, files, draft, url],
  )
  const activeIndex = active < suggestions.length ? active : -1

  const leave = () => {
    setFocused(false)
    setDraft(null)
    setActive(-1)
    inputRef.current?.blur()
  }
  const choose = (suggestion: AddressSuggestion) => {
    onSubmit(suggestion.value)
    leave()
  }

  return (
    <form
      className={cn('relative min-w-0', phone ? 'order-first basis-full' : 'mx-1 flex-1')}
      onSubmit={(event) => {
        event.preventDefault()
        const picked = suggestions[activeIndex]
        if (picked) choose(picked)
        else {
          onSubmit(draft ?? url)
          setDraft(null)
        }
      }}
    >
      <input
        ref={inputRef}
        aria-label="Preview address"
        aria-autocomplete="list"
        aria-controls={suggestions.length ? listId : undefined}
        aria-activedescendant={activeIndex >= 0 ? `${listId}-${activeIndex}` : undefined}
        value={focused ? draft ?? url : shortAddress(url)}
        onChange={(event) => {
          setDraft(event.target.value)
          setActive(-1)
          onEdit()
        }}
        onFocus={() => {
          setRecentUrls(recent())
          setFocused(true)
        }}
        onBlur={() => {
          setFocused(false)
          setDraft(null)
          setActive(-1)
        }}
        onKeyDown={(event) => {
          if (event.key === 'Escape') leave()
          else if ((event.key === 'ArrowDown' || event.key === 'ArrowUp') && suggestions.length) {
            event.preventDefault()
            const step = event.key === 'ArrowDown' ? 1 : -1
            // One step past either end is the typed text again.
            setActive((activeIndex + 1 + step + suggestions.length + 1) % (suggestions.length + 1) - 1)
          }
        }}
        spellCheck={false}
        autoCapitalize="off"
        autoCorrect="off"
        inputMode="url"
        enterKeyHint="go"
        className={cn(
          'w-full min-w-0 border text-(--color-text) outline-none transition-colors',
          phone
            ? 'h-10 rounded-full border-transparent bg-(--bg-key) px-4 text-center text-xs focus:border-(--color-text-subtle) focus:text-left'
            : 'h-8 rounded-xs border-(--color-border) bg-(--bg-input) px-2 font-mono text-xs focus:border-(--color-text-subtle) pointer-coarse:h-9',
        )}
      />
      {loading && (
        // Safari's way: a thin sweep along the field's bottom edge.
        <div role="progressbar" aria-label="Loading page" className={cn('pointer-events-none absolute bottom-px h-0.5 overflow-hidden rounded-full', phone ? 'inset-x-4' : 'inset-x-px')}>
          <div className="oa-loading-bar h-full w-2/5 rounded-full bg-(--color-text-2)/60" />
        </div>
      )}
      {suggestions.length > 0 && (
        <ul
          id={listId}
          role="listbox"
          aria-label="Suggested addresses"
          // A press on a row must not blur the field before the click lands.
          onMouseDown={(event) => event.preventDefault()}
          className={cn(
            MENU_PANEL_CLASS,
            'absolute inset-x-0 z-30 max-h-72 overflow-y-auto overscroll-contain',
            // A phone's bar is at the bottom: the list opens upward, above the keyboard.
            phone ? 'bottom-full mb-1' : 'top-full mt-1',
          )}
        >
          {suggestions.map((suggestion, index) => (
            <li key={`${suggestion.group}:${suggestion.value}`} role="presentation">
              {suggestion.group !== suggestions[index - 1]?.group && (
                <p role="presentation" className="px-2 pt-1.5 pb-1 text-meta font-medium text-(--color-text-muted)">
                  {GROUP_TITLE[suggestion.group]}
                </p>
              )}
              <button
                type="button"
                id={`${listId}-${index}`}
                role="option"
                aria-selected={index === activeIndex}
                data-highlighted={index === activeIndex || undefined}
                tabIndex={-1}
                onClick={() => choose(suggestion)}
                className={cn(MENU_ITEM_CLASS, 'font-mono', phone && 'min-h-11')}
              >
                <span className="min-w-0 truncate">{suggestion.label}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </form>
  )
}
