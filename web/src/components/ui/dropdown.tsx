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
 * The panel is portalled to document.body and positioned in viewport coords
 * so it always escapes overflow:hidden ancestors and fixed-modal stacking
 * contexts regardless of z-index — same approach as ModelCombobox.
 */
import {
  Children,
  cloneElement,
  isValidElement,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ComponentPropsWithRef,
  type ReactNode,
} from 'react'
import { createPortal } from 'react-dom'
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
  const [panelRect, setPanelRect] = useState<DOMRect | null>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)

  // Measure once on open. The panel is position:fixed so it stays put in
  // the viewport without scroll tracking — tracking scroll causes the panel
  // to visually "chase" momentum scrolling which feels broken.
  useLayoutEffect(() => {
    if (!open) return
    const rect = triggerRef.current?.getBoundingClientRect()
    if (rect) setPanelRect(rect)
  }, [open])

  // Close when a pointer-down lands outside both the trigger and the panel.
  useEffect(() => {
    if (!open) return
    const onPointerDown = (e: PointerEvent) => {
      const target = e.target as Node | null
      if (triggerRef.current?.contains(target)) return
      // Panel is portalled — check by data attribute on its root
      const panel = document.querySelector('[data-dropdown-panel]')
      if (panel?.contains(target)) return
      setOpen(false)
    }
    document.addEventListener('pointerdown', onPointerDown)
    return () => document.removeEventListener('pointerdown', onPointerDown)
  }, [open])

  // In controlled-select mode: show the selected item's label in the trigger.
  let displayLabel: ReactNode = trigger
  if (value !== undefined) {
    Children.forEach(children, (child) => {
      if (isValidElement<DropdownItemProps>(child) && child.props.value === value) {
        displayLabel = child.props.children
      }
    })
  }

  // Inject active + onSelect into DropdownItem children in select mode.
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
    <>
      {/* Trigger */}
      <button
        ref={triggerRef}
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

      {/* Panel — portalled to body, positioned in viewport coords */}
      {open && panelRect && createPortal(
        <div
          data-dropdown-panel=""
          role="menu"
          style={{
            position: 'fixed',
            top: panelRect.bottom + 4,
            left: panelRect.left,
            minWidth: panelRect.width,
            zIndex: 9999,
          }}
          className={cn(
            'rounded border border-(--color-border) bg-(--bg-card)',
            'p-1 shadow-md',
            'flex flex-col gap-0.5',
            panelClassName,
          )}
        >
          {items}
        </div>,
        document.body,
      )}
    </>
  )
}

export { Dropdown, DropdownItem }
export type { DropdownProps, DropdownItemProps }
