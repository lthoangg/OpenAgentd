/**
 * Cross-platform keyboard-shortcut helpers.
 *
 * Policy: the "primary" modifier is ``⌘`` (Meta) on macOS and ``Ctrl``
 * everywhere else — mirroring the OS-native convention already used for
 * click-modifiers (see ``Sidebar.tsx``'s ``shouldOpenSessionInNewWindow``)
 * and for the native Tauri menu accelerators (``CmdOrCtrl+…`` in
 * ``menu.rs``). The *other* modifier is always required to be absent so a
 * stray ⌘+Ctrl combo (or the wrong OS's modifier) never double-fires.
 *
 * A handful of shortcuts also require Shift to dodge a real OS/webview
 * conflict (e.g. Session Settings uses ⌘⇧A on macOS because bare ⌘A is
 * "Select All").
 */
import type { OS } from '@/hooks/use-platform'

export function isPrimaryModifierOS(os: OS): boolean {
  return os === 'macos'
}

/**
 * Returns true when ``e`` carries exactly the platform's primary modifier
 * (and, if ``shift`` is requested, exactly matches the Shift state too).
 */
export function isPrimaryShortcut(
  e: KeyboardEvent,
  os: OS,
  opts: { shift?: boolean } = {},
): boolean {
  const wantShift = opts.shift ?? false
  if (e.shiftKey !== wantShift) return false
  return isPrimaryModifierOS(os)
    ? e.metaKey && !e.ctrlKey
    : e.ctrlKey && !e.metaKey
}

/** Human-readable label, e.g. ``formatShortcut('B', 'macos') === '⌘B'``. */
export function formatShortcut(key: string, os: OS, opts: { shift?: boolean } = {}): string {
  const shift = opts.shift ?? false
  if (isPrimaryModifierOS(os)) {
    return `⌘${shift ? '⇧' : ''}${key}`
  }
  return `Ctrl+${shift ? 'Shift+' : ''}${key}`
}

/**
 * Find the nearest ancestor (including self) that carries ``data-select-container``.
 *
 * Used by the container-aware Cmd+A handler to determine whether a key event
 * originated inside a scoped selection zone (e.g. file-preview, code block)
 * so we can restrict "Select All" to that container only.
 */
export function findSelectContainer(el: Element | null): Element | null {
  let node: Element | null = el
  while (node) {
    if (node.hasAttribute('data-select-container')) return node
    node = node.parentElement
  }
  return null
}

/**
 * Dispatch a synthetic keydown carrying the platform's primary modifier so
 * window-level shortcut handlers (which use ``isPrimaryShortcut``) fire when
 * a palette item or native-menu command is activated in place of a real
 * key press.
 */
export function dispatchShortcutKey(key: string, os: OS, opts: { shift?: boolean } = {}): void {
  const mac = isPrimaryModifierOS(os)
  window.dispatchEvent(
    new KeyboardEvent('keydown', {
      key,
      ctrlKey: !mac,
      metaKey: mac,
      shiftKey: opts.shift ?? false,
      bubbles: true,
    }),
  )
}
