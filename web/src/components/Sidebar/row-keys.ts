import type { OS } from '@/hooks/use-platform'
import { isDeleteKey, isRenameKey } from '@/lib/focus/item-keys'
import { isPrimaryModifierOS } from '@/lib/keyboard-shortcut'

type KeyLike = Parameters<typeof isRenameKey>[0]

/**
 * A key the focused session row answers to (``lib/focus/item-keys``), with
 * what its menu entry shows. ``matches`` is the very predicate the row's key
 * handler uses, and ``sample`` is an event it accepts, so a test can hold the
 * menu's label to the key: the two cannot drift apart unnoticed.
 */
interface RowKey {
  matches: (event: KeyLike) => boolean
  /** The label beside the menu entry. */
  label: (os: OS) => string
  /** ``aria-keyshortcuts`` for the entry: every chord the handler takes. */
  aria: (os: OS) => string
  /** A key event ``matches`` accepts, for the label's platform. */
  sample: (os: OS) => KeyLike
}

const NO_MODIFIERS = { shiftKey: false, altKey: false, ctrlKey: false, metaKey: false }

export type RowKeyName = 'rename' | 'delete'

export const ROW_KEYS: Record<RowKeyName, RowKey> = {
  rename: {
    matches: isRenameKey,
    label: () => 'F2',
    aria: () => 'F2',
    sample: () => ({ ...NO_MODIFIERS, key: 'F2' }),
  },
  delete: {
    matches: isDeleteKey,
    // ⌘⌫ on the Mac as its menus spell it; the Delete key works everywhere.
    label: (os) => (isPrimaryModifierOS(os) ? '⌘⌫' : 'Del'),
    aria: (os) => (isPrimaryModifierOS(os) ? 'Delete Meta+Backspace' : 'Delete Control+Backspace'),
    sample: (os) => (isPrimaryModifierOS(os)
      ? { ...NO_MODIFIERS, key: 'Backspace', metaKey: true }
      : { ...NO_MODIFIERS, key: 'Delete' }),
  },
}
