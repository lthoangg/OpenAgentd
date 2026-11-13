/**
 * The chevron half of the split Send: every way to send a message while a
 * turn runs. Loaded on demand, since it only appears mid-turn.
 */
import { Dropdown, DropdownItem } from '@/components/ui/dropdown'
import type { OS } from '@/hooks/use-platform'
import { formatChord } from '@/lib/keyboard/chord'
import { isPrimaryModifierOS } from '@/lib/keyboard-shortcut'
import type { SendDelivery } from './InputComposer'

const DELIVERIES: ReadonlyArray<{ id: SendDelivery; label: string; hint: string }> = [
  { id: 'steer', label: 'Steer', hint: 'Send now, read before the next step' },
  { id: 'after-turn', label: 'Queue until done', hint: 'Sends when this turn ends' },
  { id: 'interrupt', label: 'Stop & send', hint: 'Stops this turn, then sends' },
]

/** The key hint (as the Keyboard Shortcuts sheet spells it) and ``aria-keyshortcuts`` value for each delivery. */
function deliveryShortcut(delivery: SendDelivery, os: OS): { keys: string; aria: string } {
  if (delivery === 'after-turn') return { keys: formatChord({ key: 'Enter', alt: true }, os), aria: 'Alt+Enter' }
  if (delivery === 'interrupt') {
    return { keys: formatChord({ key: 'Enter', mod: true }, os), aria: isPrimaryModifierOS(os) ? 'Meta+Enter' : 'Control+Enter' }
  }
  return { keys: formatChord({ key: 'Enter' }, os), aria: 'Enter' }
}

export function DeliveryMenu({ className, os, showShortcuts, onPick }: {
  className: string
  os: OS
  showShortcuts: boolean
  onPick: (delivery: SendDelivery) => void
}) {
  return (
    <Dropdown
      trigger={null}
      aria-label="More ways to send"
      align="end"
      className={className}
      panelClassName="w-64"
    >
      {DELIVERIES.map(({ id, label, hint }) => {
        const shortcut = deliveryShortcut(id, os)
        return (
          <DropdownItem
            key={id}
            aria-label={label}
            aria-keyshortcuts={shortcut.aria}
            onSelect={() => onPick(id)}
            className="py-1.5"
          >
            <span className="flex items-center gap-3">
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="text-(--color-text)">{label}</span>
                <span className="text-meta font-normal text-(--color-text-muted)">{hint}</span>
              </span>
              {showShortcuts && (
                <kbd className="shrink-0 rounded-xs border border-(--color-border) bg-(--bg-key) px-1.5 py-0.5 font-mono text-meta font-normal text-(--color-text-muted)">
                  {shortcut.keys}
                </kbd>
              )}
            </span>
          </DropdownItem>
        )
      })}
    </Dropdown>
  )
}
