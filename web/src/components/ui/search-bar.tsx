/**
 * SearchBar — icon-prefixed search/filter input.
 *
 * Design language: warm paper surface, crisp 1px border, search icon flush
 * left, optional trailing count badge. Focus lifts border to --focus-ring
 * with a soft /30 ring. No hover border jump.
 *
 * Usage — uncontrolled label wrapper:
 *   <SearchBar placeholder="Filter agents…" count={42} onSearch={setQuery} />
 *
 * Usage — fully controlled:
 *   <SearchBar value={query} onChange={(e) => setQuery(e.target.value)} placeholder="…" />
 *
 * The component wraps a plain <input> (not the Input primitive) so it can own
 * the full layout without fighting the primitive's w-full / border defaults.
 */
import { Search, X } from 'lucide-react'
import { useId, type ComponentPropsWithRef } from 'react'
import { cn } from '@/lib/utils'

// ─── Types ──────────────────────────────────────────────────────────────────

export interface SearchBarProps
  extends Omit<ComponentPropsWithRef<'input'>, 'type'> {
  /** Optional item count displayed as a trailing badge. Hidden while loading. */
  count?: number
  /** When true, the count badge is suppressed (e.g. still fetching). */
  loading?: boolean
  /** Visible accessible label. Falls back to `placeholder` for `<label>`. */
  label?: string
  /** Extra className forwarded to the outer wrapper div. */
  wrapperClassName?: string
  /** Called with the trimmed query string whenever the value changes. */
  onSearch?: (query: string) => void
}

// ─── Component ──────────────────────────────────────────────────────────────

function SearchBar({
  count,
  loading = false,
  label,
  wrapperClassName,
  onSearch,
  className,
  id: externalId,
  value,
  defaultValue,
  onChange,
  placeholder,
  ref,
  ...props
}: SearchBarProps) {
  const autoId = useId()
  const inputId = externalId ?? autoId

  const showCount = !loading && count !== undefined
  const showClear = typeof value === 'string' && value.length > 0

  function handleChange(e: React.ChangeEvent<HTMLInputElement>) {
    onChange?.(e)
    onSearch?.(e.target.value)
  }

  function handleClear() {
    // Fire a synthetic change event so controlled parents update correctly.
    const nativeInput = document.getElementById(inputId) as HTMLInputElement | null
    if (!nativeInput) return
    const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype,
      'value',
    )?.set
    nativeInputValueSetter?.call(nativeInput, '')
    nativeInput.dispatchEvent(new Event('input', { bubbles: true }))
    nativeInput.dispatchEvent(new Event('change', { bubbles: true }))
    nativeInput.focus()
  }

  return (
    <div className={cn('relative', wrapperClassName)}>
      {/* Accessible label — sr-only unless `label` prop is explicitly provided
          so it always exists for screen readers. */}
      <label htmlFor={inputId} className={cn(!label && 'sr-only')}>
        {label ?? placeholder}
      </label>

      {/* Wrapper that handles the border + focus-ring so the raw <input>
          can be borderless and transparent inside it. */}
      <div
        className={cn(
          // Shape
          'flex min-h-10 items-center gap-1.5 rounded-sm border md:min-h-8',
          // Surface
          'border-(--color-border) bg-(--bg-input)',
          // Focus-within ring — matches Input primitive behaviour
          'transition-colors',
          'focus-within:border-(--focus-ring) focus-within:ring-2 focus-within:ring-(--focus-ring)/30',
        )}
      >
        {/* Search icon — non-interactive, purely decorative */}
        <Search
          size={12}
          aria-hidden="true"
          className="ml-2.5 shrink-0 text-(--color-text-muted)"
        />

        {/* The input itself — no own border, transparent bg, fills remaining space */}
        <input
          ref={ref}
          id={inputId}
          type="search"
          value={value}
          defaultValue={defaultValue}
          onChange={handleChange}
          placeholder={placeholder}
          className={cn(
            'min-w-0 flex-1 bg-transparent py-2 text-xs text-(--color-text) md:py-1.5',
            'placeholder:text-(--color-text-muted)/60',
            'outline-none',
            // Remove browser-default search cancel button — we render our own
            '[&::-webkit-search-cancel-button]:appearance-none',
            className,
          )}
          {...props}
        />

        {/* Clear button — visible only when there is a value */}
        {showClear && (
          <button
            type="button"
            aria-label="Clear search"
            onClick={handleClear}
            className={cn(
              'mr-1 flex h-8 w-8 shrink-0 items-center justify-center rounded-sm md:h-5 md:w-5',
              'text-(--color-text-subtle) transition-colors',
              'hover:bg-(--bg-key) hover:text-(--color-text)',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-(--focus-ring)/40',
            )}
          >
            <X size={10} aria-hidden="true" />
          </button>
        )}

        {/* Count badge — trailing, monospace, tabular nums */}
        {showCount && !showClear && (
          <span
            aria-live="polite"
            aria-atomic="true"
            className="mr-2.5 shrink-0 font-mono text-[10px] tabular-nums text-(--color-text-subtle) select-none"
          >
            {count === 1 ? '1 item' : `${count} items`}
          </span>
        )}
      </div>
    </div>
  )
}

export { SearchBar }
