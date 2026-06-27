/**
 * Dropdown — select/menu primitive built on @base-ui/react/menu.
 *
 * base-ui's Positioner handles all anchor tracking, scroll, resize,
 * viewport-flip, and portal — no manual getBoundingClientRect needed.
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
 */
import {
  Children,
  cloneElement,
  isValidElement,
  type ComponentPropsWithRef,
  type ReactNode,
} from 'react'
import { Menu } from '@base-ui/react/menu'
import { ChevronDown, Check } from 'lucide-react'
import { cn } from '@/lib/utils'
import { buttonVariants } from '@/components/ui/button'

// ─── Item ─────────────────────────────────────────────────────────────────────

interface DropdownItemProps extends ComponentPropsWithRef<'div'> {
  /** Highlights this item as the currently active/selected one. */
  active?: boolean
  /** Value used when the parent <Dropdown> is in controlled-select mode. */
  value?: string
  /** Called when the item is selected. */
  onSelect?: () => void
}

function DropdownItem({
  active,
  value: _value,
  onSelect,
  className,
  children,
  ref,
  ...props
}: DropdownItemProps) {
  return (
    <Menu.Item
      ref={ref}
      onClick={onSelect}
      className={cn(
        'flex w-full cursor-pointer items-center gap-2 rounded px-2 py-1 text-left text-xs font-medium outline-none',
        'transition-colors',
        'data-highlighted:bg-(--bg-key)',
        active ? 'text-(--color-text)' : 'text-(--color-text-2)',
        className,
      )}
      {...props}
    >
      <span className="flex-1">{children}</span>
      {active && (
        <Check size={11} className="shrink-0 text-(--color-text-muted)" aria-hidden="true" />
      )}
    </Menu.Item>
  )
}

// ─── Root ─────────────────────────────────────────────────────────────────────

interface DropdownProps {
  /** Content rendered inside the trigger button. */
  trigger: ReactNode
  /** Menu items — use <DropdownItem> children. */
  children: ReactNode
  /** Controlled select: currently selected value. */
  value?: string
  /** Controlled select: called with the new value when an item is picked. */
  onValueChange?: (value: string) => void
  /** Extra classes on the trigger button (e.g. width, min-h-11). */
  className?: string
  /** Extra classes on the dropdown panel. */
  panelClassName?: string
  /** id for form label association. */
  id?: string
  /** aria-label for the trigger button. */
  'aria-label'?: string
  /** aria-invalid for form validation styling. */
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
  id,
  'aria-label': ariaLabel,
  'aria-invalid': ariaInvalid,
  disabled,
}: DropdownProps) {
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
            },
          })
        })
      : children

  return (
    <Menu.Root>
      {/* Trigger */}
      <Menu.Trigger
        id={id}
        disabled={disabled}
        aria-label={ariaLabel}
        aria-invalid={ariaInvalid}
        className={cn(
          buttonVariants({ variant: 'default', size: 'trigger' }),
          'justify-between',
          'data-popup-open:border-(--focus-ring)',
          'aria-invalid:border-(--color-error) aria-invalid:ring-2 aria-invalid:ring-(--color-error)/20',
          className,
        )}
      >
        <span className="flex min-w-0 flex-1 items-center gap-1.5 truncate">{displayLabel}</span>
        <ChevronDown
          size={11}
          className="shrink-0 text-(--color-text-muted) transition-transform duration-150 group-data-popup-open:rotate-180"
          aria-hidden="true"
        />
      </Menu.Trigger>

      {/* Panel — base-ui Positioner handles portal + anchor + scroll + flip */}
      <Menu.Portal>
        <Menu.Positioner
          side="bottom"
          align="start"
          sideOffset={4}
          alignOffset={0}
          className="isolate z-50"
        >
          <Menu.Popup
            className={cn(
              'min-w-(--anchor-width) origin-(--transform-origin)',
              'rounded border border-(--color-border) bg-(--bg-card)',
              'p-1 shadow-md',
              'flex flex-col gap-0.5',
              'duration-100 outline-none',
              'data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95',
              'data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95',
              panelClassName,
            )}
          >
            {items}
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  )
}

export { Dropdown, DropdownItem }
export type { DropdownProps, DropdownItemProps }
