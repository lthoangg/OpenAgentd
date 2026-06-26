/**
 * Dropdown — lightweight select-style menu primitive.
 *
 * Design language from the "Changes / Commits / Tree" git panel selector:
 *   default-variant trigger · crisp 1px border panel · text-xs items ·
 *   active item in --color-text, inactive in --color-text-2 · hover: --bg-key
 *
 * No Radix, no floating-ui. Plain state + fixed backdrop dismiss.
 * For complex menus (sub-menus, checkboxes, icons) reach for a Radix solution.
 *
 * Usage:
 *   <Dropdown
 *     trigger={<><GitCompare size={12} />Changes (3)</>}
 *     className="w-36"
 *   >
 *     <DropdownItem active={tab === 'changes'} onSelect={() => setTab('changes')}>
 *       Changes (3)
 *     </DropdownItem>
 *     <DropdownItem active={tab === 'commits'} onSelect={() => setTab('commits')}>
 *       Commits
 *     </DropdownItem>
 *   </Dropdown>
 */
import { useRef, useState, type ComponentPropsWithRef, type ReactNode } from 'react'
import { ChevronDown } from 'lucide-react'
import { cn } from '@/lib/utils'
import { buttonVariants } from '@/components/ui/button'

// ─── Item ─────────────────────────────────────────────────────────────────────

interface DropdownItemProps extends ComponentPropsWithRef<'button'> {
  /** Highlights this item as the currently selected value. */
  active?: boolean
  /** Called when the item is selected — use instead of onClick for clarity. */
  onSelect?: () => void
}

function DropdownItem({ active, onSelect, onClick, className, ref, ...props }: DropdownItemProps) {
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
        'w-full rounded px-2 py-1 text-left text-xs font-medium',
        'transition-colors cursor-pointer',
        'hover:bg-(--bg-key)',
        'focus-visible:outline-none focus-visible:bg-(--bg-key)',
        active ? 'text-(--color-text)' : 'text-(--color-text-2)',
        className,
      )}
      {...props}
    />
  )
}

// ─── Root ─────────────────────────────────────────────────────────────────────

interface DropdownProps {
  /** Content rendered inside the trigger button — label, icon, count, etc. */
  trigger: ReactNode
  /** Menu items — use <DropdownItem> children. */
  children: ReactNode
  /** Extra classes on the trigger button (e.g. width). */
  className?: string
  /** Extra classes on the dropdown panel. */
  panelClassName?: string
}

function Dropdown({ trigger, children, className, panelClassName }: DropdownProps) {
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)

  return (
    <div ref={rootRef} className="relative">
      {/* Trigger */}
      <button
        type="button"
        onClick={() => setOpen((prev) => !prev)}
        aria-haspopup="menu"
        aria-expanded={open}
        className={cn(
          buttonVariants({ variant: 'default', size: 'sm' }),
          'justify-between gap-1.5',
          className,
        )}
      >
        <span className="flex min-w-0 items-center gap-1.5 truncate">{trigger}</span>
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
            onClick={() => setOpen(false)}
          >
            {children}
          </div>
        </>
      )}
    </div>
  )
}

export { Dropdown, DropdownItem }
export type { DropdownProps, DropdownItemProps }
