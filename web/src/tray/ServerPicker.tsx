import { useEffect, useRef } from 'react'
import { Check, ChevronDown, Server } from 'lucide-react'
import { useDeferredUnmount } from '@/components/ui/_use-deferred-unmount'
import { DURATIONS_S } from '@/lib/motion'
import type { TrayServerOption } from './usage'

/**
 * The server the popup reads usage from. A listbox: the popup owns the
 * keys (↑ ↓ Home End Enter Esc) so they work wherever focus sits.
 */
export function ServerPicker({ servers, selected, label, open, active, onOpenChange, onActiveChange, onChoose }: {
  servers: TrayServerOption[]
  selected: string
  /** The server shown on the trigger. */
  label: string
  open: boolean
  /** Highlighted option while open. */
  active: number
  onOpenChange: (open: boolean) => void
  onActiveChange: (index: number) => void
  onChoose: (id: string) => void
}) {
  const containerRef = useRef<HTMLSpanElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const { mounted, closing } = useDeferredUnmount(open, DURATIONS_S.fast * 1000)
  const choosable = servers.length > 1

  useEffect(() => {
    if (!open) return
    const onPointerDown = (event: PointerEvent) => {
      if (!containerRef.current?.contains(event.target as Node)) onOpenChange(false)
    }
    document.addEventListener('pointerdown', onPointerDown)
    return () => document.removeEventListener('pointerdown', onPointerDown)
  }, [open, onOpenChange])

  // The open list takes focus, so assistive tech reads the highlighted
  // option (aria-activedescendant); focus goes back to the trigger as it
  // closes, so a second Esc (handled by the popup) starts from there.
  const wasOpen = useRef(open)
  useEffect(() => {
    if (!open && wasOpen.current) triggerRef.current?.focus()
    wasOpen.current = open
  }, [open])
  // The list mounts a render after `open` flips (useDeferredUnmount).
  useEffect(() => {
    if (open && mounted) listRef.current?.focus()
  }, [open, mounted])

  return (
    <span ref={containerRef} className="picker">
      <button
        ref={triggerRef}
        type="button"
        className="picker-trigger"
        disabled={!choosable}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? 'tray-server-list' : undefined}
        aria-label={`Server: ${label}`}
        title={label}
        onClick={() => onOpenChange(!open)}
      >
        <Server size={12} strokeWidth={2} aria-hidden="true" />
        <span className="picker-name">{label}</span>
        {choosable && <ChevronDown size={11} strokeWidth={2.2} className="picker-chevron" aria-hidden="true" />}
      </button>
      {mounted && (
        <div
          ref={listRef}
          id="tray-server-list"
          className="menu"
          role="listbox"
          aria-label="Server"
          tabIndex={-1}
          aria-activedescendant={open ? `tray-server-${active}` : undefined}
          data-closing={closing ? '' : undefined}
        >
          {servers.map((server, index) => (
            <button
              key={server.id}
              id={`tray-server-${index}`}
              type="button"
              role="option"
              tabIndex={-1}
              className="option"
              aria-selected={server.id === selected}
              data-active={index === active ? '' : undefined}
              onPointerEnter={() => onActiveChange(index)}
              onClick={() => onChoose(server.id)}
            >
              <span className="option-text">
                <span className="option-name">{server.name}</span>
                {server.detail && <span className="option-detail">{server.detail}</span>}
              </span>
              <Check size={12} strokeWidth={2.5} className="option-check" aria-hidden="true" />
            </button>
          ))}
        </div>
      )}
    </span>
  )
}
