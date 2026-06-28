/**
 * Dropdown — select/menu primitive, zero external dependencies.
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
 * The panel is portal-rendered and anchored below (flip to top if needed).
 * Panel min-width matches the trigger width via inline style.
 */
import {
  Children,
  cloneElement,
  createContext,
  isValidElement,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ComponentPropsWithRef,
  type ReactNode,
} from 'react'
import { createPortal } from 'react-dom'
import { ChevronDown, Check } from 'lucide-react'
import { cn } from '@/lib/utils'
import { buttonVariants } from '@/components/ui/button'
import { useDeferredUnmount } from '@/components/ui/_use-deferred-unmount'

// ─── Context ────────────────────────────────────────────────────────────────

interface DropdownCtx {
  open: boolean
  setOpen: (v: boolean) => void
  triggerRef: React.RefObject<HTMLButtonElement | null>
}
const DropdownContext = createContext<DropdownCtx | null>(null)

function useDropdownCtx() {
  const ctx = useContext(DropdownContext)
  if (!ctx) throw new Error('DropdownItem must be inside Dropdown')
  return ctx
}

// ─── Item ────────────────────────────────────────────────────────────────────

export interface DropdownItemProps extends ComponentPropsWithRef<'button'> {
  active?: boolean
  value?: string
  onSelect?: () => void
}

function DropdownItem({ active, value: _value, onSelect, className, children, ...props }: DropdownItemProps) {
  const { setOpen } = useDropdownCtx()
  return (
    <button
      type="button"
      role="menuitem"
      className={cn(
        'flex w-full cursor-pointer items-center gap-2 rounded px-2 py-1 text-left text-xs font-medium outline-none',
        'transition-colors hover:bg-(--bg-key) focus-visible:bg-(--bg-key)',
        active ? 'text-(--color-text)' : 'text-(--color-text-2)',
        className,
      )}
      onClick={() => {
        onSelect?.()
        setOpen(false)
      }}
      {...props}
    >
      <span className="flex-1">{children}</span>
      {active && <Check size={11} className="shrink-0 text-(--color-text-muted)" aria-hidden="true" />}
    </button>
  )
}

// ─── Root ────────────────────────────────────────────────────────────────────

export interface DropdownProps {
  trigger: ReactNode
  children: ReactNode
  value?: string
  onValueChange?: (value: string) => void
  className?: string
  panelClassName?: string
  id?: string
  'aria-label'?: string
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
  const [open, setOpen] = useState(false)
  const { mounted: panelMounted, closing: panelClosing } = useDeferredUnmount(open, 100)
  const triggerRef = useRef<HTMLButtonElement | null>(null)
  const panelRef = useRef<HTMLDivElement | null>(null)
  const [pos, setPos] = useState({ top: 0, left: 0, width: 0 })

  const reposition = useCallback(() => {
    const t = triggerRef.current
    if (!t) return
    const rect = t.getBoundingClientRect()
    const panelH = panelRef.current?.offsetHeight ?? 200
    const flipsUp = rect.bottom + 4 + window.scrollY + panelH > window.innerHeight + window.scrollY
    setPos({
      top: flipsUp ? rect.top - panelH - 4 + window.scrollY : rect.bottom + 4 + window.scrollY,
      left: rect.left + window.scrollX,
      width: rect.width,
    })
  }, [])

  useEffect(() => {
    if (!panelMounted) return
    reposition()
    window.addEventListener('scroll', reposition, { passive: true, capture: true })
    window.addEventListener('resize', reposition)
    return () => {
      window.removeEventListener('scroll', reposition, { capture: true })
      window.removeEventListener('resize', reposition)
    }
  }, [panelMounted, reposition])

  // Outside click closes
  useEffect(() => {
    if (!open) return
    const handler = (e: MouseEvent) => {
      if (
        panelRef.current?.contains(e.target as Node) ||
        triggerRef.current?.contains(e.target as Node)
      ) return
      setOpen(false)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [open])

  // Escape closes
  useEffect(() => {
    if (!open) return
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false) }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [open])

  // In select mode: derive display label + inject active+onSelect into items
  let displayLabel: ReactNode = trigger
  const items = Children.map(children, (child) => {
    if (!isValidElement<DropdownItemProps>(child)) return child
    if (value !== undefined) {
      if (child.props.value === value) displayLabel = child.props.children
      return cloneElement(child, {
        active: child.props.value === value,
        onSelect: () => {
          if (child.props.value !== undefined) onValueChange?.(child.props.value)
          child.props.onSelect?.()
        },
      })
    }
    return child
  })

  return (
    <DropdownContext.Provider value={{ open, setOpen, triggerRef }}>
      <button
        ref={triggerRef}
        id={id}
        type="button"
        disabled={disabled}
        aria-label={ariaLabel}
        aria-invalid={ariaInvalid}
        aria-haspopup="menu"
        aria-expanded={open}
        data-popup-open={open || undefined}
        className={cn(
          buttonVariants({ variant: 'default', size: 'trigger' }),
          'justify-between',
          open && 'border-(--focus-ring)',
          'aria-invalid:border-(--color-error) aria-invalid:ring-2 aria-invalid:ring-(--color-error)/20',
          className,
        )}
        onClick={() => { setOpen((v) => !v); reposition() }}
      >
        <span className="flex min-w-0 flex-1 items-center gap-1.5 truncate">{displayLabel}</span>
        <ChevronDown
          size={11}
          className={cn('shrink-0 text-(--color-text-muted) transition-transform duration-150', open && 'rotate-180')}
          aria-hidden="true"
        />
      </button>

      {panelMounted && createPortal(
        <div
          ref={panelRef}
          role="menu"
          data-slot="dropdown-panel"
          className={cn(
            'fixed z-50 flex flex-col gap-0.5',
            'min-w-[var(--dropdown-anchor-width)]',
            'rounded border border-(--color-border) bg-(--bg-card)',
            'p-1 shadow-md outline-none',
            'duration-100',
            panelClosing
              ? 'animate-out fade-out-0 zoom-out-95'
              : 'animate-in fade-in-0 zoom-in-95',
            panelClassName,
          )}
          style={{ top: pos.top, left: pos.left, '--dropdown-anchor-width': `${pos.width}px` } as React.CSSProperties}
        >
          {items}
        </div>,
        document.body,
      )}
    </DropdownContext.Provider>
  )
}

export { Dropdown, DropdownItem }
