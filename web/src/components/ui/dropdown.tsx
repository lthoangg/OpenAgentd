/**
 * Dropdown — lightweight select/menu primitive.
 *
 * Two modes:
 *
 *  Action menu (no value prop):
 *    <Dropdown trigger={<>Label</>}>
 *      <DropdownItem onSelect={() => …}>Option</DropdownItem>
 *    </Dropdown>
 *
 *  Controlled select (value + onValueChange):
 *    <Dropdown value={current} onValueChange={setValue} trigger="Choose…">
 *      <DropdownItem value="a">Option A</DropdownItem>
 *      <DropdownItem value="b">Option B</DropdownItem>
 *    </Dropdown>
 *
 * Design language from the "Changes / Commits / Tree" git panel selector:
 *   default-variant trigger · crisp 1px border panel · text-xs items ·
 *   active item in --color-text, inactive in --color-text-2 · hover: --bg-key
 *
 * No Radix, no floating-ui. Plain state + fixed backdrop dismiss.
 */
import {
  Children,
  cloneElement,
  isValidElement,
  useRef,
  useState,
  type ComponentPropsWithRef,
  type ReactNode,
} from 'react'
import { ChevronDown, Check } from 'lucide-react'
import { cn } from '@/lib/utils'
import { buttonVariants } from '@/components/ui/button'

// ─── Item ─────────────────────────────────────────────────────────────────────

interface DropdownItemProps extends ComponentPropsWithRef<'button'> {
  /** Highlights this item as the currently active/selected one. */
  active?: boolean
  /** Value used when the parent <Dropdown> is in controlled-select mode. */
  value?: string
  /** Called when the item is selected — use instead of onClick for clarity. */
  onSelect?: () => void
}

function DropdownItem({
  active,
  value: _value,
  onSelect,
  onClick,
  className,
  children,
  ref,
  ...props
}: DropdownItemProps) {
  return (
    <button
      ref={ref}
      type="button"
      role="menuitem"
      onClick={(e) => {
        onSelect?.()
        onClick?.(e)
      }}
      className={cn(
        'flex w-full items-center gap-2 rounded px-2 py-1 text-left text-xs font-medium',
        'transition-colors cursor-pointer',
        'hover:bg-(--bg-key)',
        'focus-visible:outline-none focus-visible:bg-(--bg-key)',
        active ? 'text-(--color-text)' : 'text-(--color-text-2)',
        className,
      )}
      {...props}
    >
      <span className="flex-1">{children}</span>
      {active && (
        <Check size={11} className="shrink-0 text-(--color-text-muted)" aria-hidden="true" />
      )}
    </button>
  )
}

// ─── Root ─────────────────────────────────────────────────────────────────────

interface DropdownProps {
  /** Content rendered inside the trigger button — label, icon, count, etc. */
  trigger: ReactNode
  /** Menu items — use <DropdownItem> children. */
  children: ReactNode
  /**
   * Controlled select mode: the currently selected value.
   * When provided, the trigger shows the matching item's label and each
   * DropdownItem with a matching `value` prop gets `active` injected.
   */
  value?: string
  /** Controlled select mode: called with the new value when an item is picked. */
  onValueChange?: (value: string) => void
  /** Extra classes on the trigger button (e.g. width, min-h-11). */
  className?: string
  /** Extra classes on the dropdown panel. */
  panelClassName?: string
  /** aria-label for the trigger button. */
  'aria-label'?: string
  /** aria-invalid — passed through to the trigger for form validation styling. */
  'aria-invalid'?: boolean | 'true' | 'false'
  disabled?: boolean
}

function Dropdown({
  trigger,
  children,
  value,
  onValueChange,
  className,
  panelClassName,
  'aria-label': ariaLabel,
  'aria-invalid': ariaInvalid,
  disabled,
}: DropdownProps) {
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)

  // In controlled-select mode: find the label of the selected item
  // so we can show it in the trigger instead of the static trigger prop.
  let displayLabel: ReactNode = trigger
  if (value !== undefined) {
    Children.forEach(children, (child) => {
      if (isValidElement<DropdownItemProps>(child) && child.props.value === value) {
        displayLabel = child.props.children
      }
    })
  }

  // Inject active + onSelect into DropdownItem children when in select mode.
  const items =
    value !== undefined
      ? Children.map(children, (child) => {
          if (!isValidElement<DropdownItemProps>(child)) return child
          const isActive = child.props.value === value
          return cloneElement(child, {
            active: isActive,
            onSelect: () => {
              if (child.props.value !== undefined) onValueChange?.(child.props.value)
              child.props.onSelect?.()
              setOpen(false)
            },
          })
        })
      : children

  return (
    <div ref={rootRef} className="relative">
      {/* Trigger */}
      <button
        type="button"
        onClick={() => !disabled && setOpen((prev) => !prev)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={ariaLabel}
        aria-invalid={ariaInvalid}
        disabled={disabled}
        className={cn(
          buttonVariants({ variant: 'default', size: 'trigger' }),
          'justify-between',
          'aria-invalid:border-(--color-error) aria-invalid:ring-2 aria-invalid:ring-(--color-error)/20',
          className,
        )}
      >
        <span className="flex min-w-0 flex-1 items-center gap-1.5 truncate">{displayLabel}</span>
        <ChevronDown
          size={11}
          className={cn(
            'shrink-0 text-(--color-text-muted) transition-transform duration-150',
            open && 'rotate-180',
          )}
          aria-hidden="true"
        />
      </button>

      {/* Panel */}
      {open && (
        <>
          {/* Backdrop — closes on outside click */}
          <div
            className="fixed inset-0 z-10"
            aria-hidden="true"
            onClick={() => setOpen(false)}
          />
          <div
            role="menu"
            className={cn(
              'absolute left-0 top-full z-20 mt-1',
              'min-w-full',
              'rounded border border-(--color-border) bg-(--bg-card)',
              'p-1 shadow-md',
              'flex flex-col gap-0.5',
              panelClassName,
            )}
            // Don't close on item click here — items handle their own close
          >
            {items}
          </div>
        </>
      )}
    </div>
  )
}

export { Dropdown, DropdownItem }
export type { DropdownProps, DropdownItemProps }
