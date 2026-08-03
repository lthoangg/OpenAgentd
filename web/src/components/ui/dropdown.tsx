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
 *
 * ## Keyboard
 *
 * Focus stays on the trigger the whole time and the active option is published
 * via `aria-activedescendant`. That is deliberate: the panel is portalled to
 * `document.body`, so it sits *outside* any modal focus trap (which scopes its
 * query to the dialog element). Moving real focus into the panel would put it
 * beyond the trap's reach and strand keyboard users with an open menu they
 * cannot operate.
 *
 *   ArrowDown / ArrowUp  open, then move the active option (no wrap)
 *   Home / End           jump to the first / last option
 *   Enter / Space        open, or select the active option
 *   Escape               close the menu only, without reaching outer layers
 *   Tab                  close the menu and let focus move on
 */
import {
  Children,
  cloneElement,
  createContext,
  isValidElement,
  useCallback,
  useContext,
  useEffect,
  useId,
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
  /** Set by Dropdown: this item is the keyboard's active option. */
  highlighted?: boolean
}

function DropdownItem({
  active,
  value: _value,
  onSelect,
  highlighted,
  className,
  children,
  ...props
}: DropdownItemProps) {
  const { setOpen } = useDropdownCtx()
  return (
    <button
      type="button"
      role="menuitem"
      // Focus never enters the panel (see the module docstring), so the active
      // option is conveyed by attribute rather than by focus.
      tabIndex={-1}
      data-highlighted={highlighted || undefined}
      className={cn(
        'flex w-full cursor-pointer items-center gap-2 rounded px-2 py-1 text-left text-xs font-medium outline-none',
        'transition-colors hover:bg-(--bg-key) focus-visible:bg-(--bg-key)',
        highlighted && 'bg-(--bg-key)',
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
  const uid = useId()
  /** Index of the keyboard's active option, or -1 for none. */
  const [highlight, setHighlight] = useState(-1)

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

  // Drop the active option when the menu closes so a stale
  // aria-activedescendant never points at a hidden node.
  useEffect(() => {
    if (!open) setHighlight(-1)
  }, [open])

  // In select mode: derive display label + inject active+onSelect into items
  let displayLabel: ReactNode = trigger
  /** Per-item keyboard metadata, rebuilt every render so the key handler below
   *  always closes over the current children. */
  const meta: { id: string; disabled: boolean; select: () => void }[] = []
  let index = -1
  const items = Children.map(children, (child) => {
    if (!isValidElement<DropdownItemProps>(child)) return child
    index += 1
    const i = index
    const id = `${uid}-item-${i}`
    meta.push({
      id,
      disabled: !!child.props.disabled,
      // Selection goes straight through the props rather than the injected
      // onSelect below, so a keyboard select never fires onValueChange twice.
      select: () => {
        if (value !== undefined && child.props.value !== undefined) {
          onValueChange?.(child.props.value)
        }
        child.props.onSelect?.()
      },
    })
    const shared = { id, highlighted: i === highlight }
    if (value !== undefined) {
      if (child.props.value === value) displayLabel = child.props.children
      return cloneElement(child, {
        ...shared,
        active: child.props.value === value,
        onSelect: () => {
          if (child.props.value !== undefined) onValueChange?.(child.props.value)
          child.props.onSelect?.()
        },
        onMouseEnter: () => setHighlight(i),
      })
    }
    return cloneElement(child, { ...shared, onMouseEnter: () => setHighlight(i) })
  })

  const navigable = meta.map((m, i) => (m.disabled ? -1 : i)).filter((i) => i >= 0)
  /** Where the keyboard starts: the selected option if there is one. */
  const initialIndex = () => {
    const selected = Children.toArray(children).findIndex(
      (child) => isValidElement<DropdownItemProps>(child) && child.props.value === value,
    )
    if (selected >= 0 && !meta[selected]?.disabled) return selected
    return navigable[0] ?? -1
  }
  const step = (from: number, delta: number) => {
    const at = navigable.indexOf(from)
    if (at < 0) return navigable[0] ?? -1
    // Clamped, not wrapping: arrowing past the end is nearly always a
    // mis-press, and silently jumping to the other end hides it.
    const next = Math.min(Math.max(at + delta, 0), navigable.length - 1)
    return navigable[next] ?? from
  }

  const handleTriggerKeyDown = (e: React.KeyboardEvent<HTMLButtonElement>) => {
    if (disabled) return

    if (e.key === 'Escape') {
      if (!open) return // No menu of ours to close: let an outer layer have it.
      e.preventDefault()
      // Keeps an enclosing modal (which listens on document) from closing too.
      e.stopPropagation()
      setOpen(false)
      return
    }

    if (e.key === 'Tab') {
      if (open) setOpen(false)
      return // Never preventDefault: focus must keep moving.
    }

    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      if (!open) {
        setOpen(true)
        reposition()
        setHighlight(initialIndex())
        return
      }
      setHighlight((h) => (h < 0 ? initialIndex() : step(h, e.key === 'ArrowDown' ? 1 : -1)))
      return
    }

    if (open && (e.key === 'Home' || e.key === 'End')) {
      e.preventDefault()
      setHighlight(e.key === 'Home' ? navigable[0] ?? -1 : navigable[navigable.length - 1] ?? -1)
      return
    }

    if (e.key === 'Enter' || e.key === ' ') {
      // preventDefault suppresses the click the browser would synthesise for a
      // focused button, which would otherwise re-toggle what we just set.
      e.preventDefault()
      if (!open) {
        setOpen(true)
        reposition()
        setHighlight(initialIndex())
        return
      }
      const target = meta[highlight]
      if (target && !target.disabled) target.select()
      setOpen(false)
    }
  }

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
        aria-activedescendant={open && highlight >= 0 ? meta[highlight]?.id : undefined}
        data-popup-open={open || undefined}
        className={cn(
          buttonVariants({ variant: 'default', size: 'trigger' }),
          'justify-between',
          open && 'border-(--focus-ring)',
          'aria-invalid:border-(--color-error) aria-invalid:ring-2 aria-invalid:ring-(--color-error)/20',
          className,
        )}
        onKeyDown={handleTriggerKeyDown}
        onClick={() => {
          const next = !open
          setOpen(next)
          reposition()
          // Seed the active option so arrow keys work after a mouse open.
          if (next) setHighlight(initialIndex())
        }}
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
