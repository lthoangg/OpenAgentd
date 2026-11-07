/**
 * The app's keyboard shortcuts, in one table.
 *
 * Registration (``useAppShortcut`` / ``appShortcut`` in ``lib/keyboard``),
 * labels in tooltips and the command palette, the chords swallowed behind
 * dialogs, and synthetic dispatch from native menu commands all read from
 * here, so a key changes in one place. Every shortcut uses the platform's
 * primary modifier (⌘ on macOS, Ctrl elsewhere; see ``keyboard-shortcut.ts``),
 * except the few marked ``ctrl``, which are the Control key on every OS (⌃⌥←).
 */
import type { OS } from '@/hooks/use-platform'
import { dispatchShortcutKey, formatShortcut, isPrimaryModifierOS } from '@/lib/keyboard-shortcut'
import type { KeyChord } from '@/lib/keyboard/chord'

export interface AppShortcut {
  key: string
  /** Match the physical key (layouts that print another character). */
  code?: string
  shift?: boolean
  alt?: boolean
  /** The Control key itself on every OS instead of the primary modifier. */
  ctrl?: boolean
  /** May replace an open overlay instead of being blocked by it. */
  switcher?: boolean
}

export const APP_SHORTCUTS = {
  newSession: { key: 'N' },
  // Open a folder as a workspace (File → Open Workspace… on the desktop).
  openWorkspace: { key: 'O' },
  // The run picker (model, thinking, account): one short chord, matched on
  // the physical key for layouts that print another character there.
  sessionSettings: { key: '.', code: 'Period' },
  workspaceFiles: { key: 'D' },
  maximizeDock: { key: 'D', shift: true },
  // Split the focused Review panel pane right or down, as often as there is
  // room; closing a pane's last tab joins it back.
  splitDock: { key: '\\', code: 'Backslash' },
  splitDockDown: { key: '\\', code: 'Backslash', shift: true },
  // Send the focused tab left, right, up or down (⌃⌥+arrow, Ctrl+Alt
  // elsewhere): a new pane on that side with the tab in it, or
  // the pane there when it is its pane's only tab.
  splitTabLeft: { key: 'ArrowLeft', ctrl: true, alt: true },
  splitTabRight: { key: 'ArrowRight', ctrl: true, alt: true },
  splitTabUp: { key: 'ArrowUp', ctrl: true, alt: true },
  splitTabDown: { key: 'ArrowDown', ctrl: true, alt: true },
  // Find in this session's transcript (only while focus is in the chat).
  findInSession: { key: 'F' },
  tasks: { key: 'T' },
  quickOpen: { key: 'P', switcher: true },
  commandPalette: { key: 'K', switcher: true },
  // The palette opened on Switch Workspace/Session…, or on the current
  // workspace's sessions inside it.
  switchWorkspace: { key: 'L', switcher: true },
  workspaceSessions: { key: 'L', shift: true, switcher: true },
  sidebar: { key: 'B' },
  // Search session titles in the sidebar (shown first if it was hidden).
  searchSessions: { key: 'F', shift: true },
  focusChat: { key: 'I' },
  closeTab: { key: 'W' },
  settings: { key: ',', switcher: true },
  // Save the form on the open Settings page or editor. Bound only inside the
  // Settings modal (`within: settingsRoot`), never app-wide; listed here so the
  // key is spelled out in one place and swallowed behind dialogs like the rest.
  save: { key: 'S' },
  historyBack: { key: '[' },
  historyForward: { key: ']' },
  // Alt keeps bare ⌘↑/⌘↓ for the caret and scroll-to-end they already mean.
  previousPrompt: { key: 'ArrowUp', alt: true },
  nextPrompt: { key: 'ArrowDown', alt: true },
  // No terminal key: Open Terminal in the palette and the Review panel's "+"
  // menu start one, and a focused terminal keeps Control+` for its shell.
  openGit: { key: 'G', shift: true },
  shortcutsHelp: { key: '/', switcher: true },
  // Dock tabs by position; matched on the digit key so layouts that print
  // another character there (AZERTY) work too. 9 is the last tab.
  dockTab1: { key: '1', code: 'Digit1' },
  dockTab2: { key: '2', code: 'Digit2' },
  dockTab3: { key: '3', code: 'Digit3' },
  dockTab4: { key: '4', code: 'Digit4' },
  dockTab5: { key: '5', code: 'Digit5' },
  dockTab6: { key: '6', code: 'Digit6' },
  dockTab7: { key: '7', code: 'Digit7' },
  dockTab8: { key: '8', code: 'Digit8' },
  dockTab9: { key: '9', code: 'Digit9' },
} as const satisfies Record<string, AppShortcut>

export type AppShortcutName = keyof typeof APP_SHORTCUTS

/** ⌘1–⌘9 in order: the dock tab at that position, the last for 9. */
export const DOCK_TAB_SHORTCUTS = [
  'dockTab1', 'dockTab2', 'dockTab3', 'dockTab4', 'dockTab5', 'dockTab6', 'dockTab7', 'dockTab8', 'dockTab9',
] as const satisfies readonly AppShortcutName[]

/** Next / previous dock tab: Control+Tab on every OS (not ⌘Tab, the app switcher). */
export const NEXT_DOCK_TAB_CHORD: KeyChord = { key: 'Tab', ctrl: true }
export const PREV_DOCK_TAB_CHORD: KeyChord = { key: 'Tab', ctrl: true, shift: true }
/**
 * The same steps the platform's way: ⌘⇧] / ⌘⇧[
 * on macOS, Ctrl+PageDown / PageUp elsewhere. Only the platform's own pair
 * is bound (``dockTabStepKeys``); the brackets match the physical key, which
 * prints "{" and "}" with Shift.
 */
export const NEXT_DOCK_TAB_KEYS = {
  mac: { key: ']', code: 'BracketRight', mod: true, shift: true },
  other: { key: 'PageDown', ctrl: true, shift: false },
} as const satisfies Record<string, KeyChord>
export const PREV_DOCK_TAB_KEYS = {
  mac: { key: '[', code: 'BracketLeft', mod: true, shift: true },
  other: { key: 'PageUp', ctrl: true, shift: false },
} as const satisfies Record<string, KeyChord>

/** The platform's own next / previous dock tab pair, beside ⌃Tab / ⌃⇧Tab. */
export function dockTabStepKeys(os: OS): { next: KeyChord; prev: KeyChord } {
  return isPrimaryModifierOS(os)
    ? { next: NEXT_DOCK_TAB_KEYS.mac, prev: PREV_DOCK_TAB_KEYS.mac }
    : { next: NEXT_DOCK_TAB_KEYS.other, prev: PREV_DOCK_TAB_KEYS.other }
}

/** The chord the keyboard dispatcher matches for a shortcut. */
export function chordOf(shortcut: AppShortcut): KeyChord {
  if (shortcut.ctrl) {
    const chord: KeyChord = { key: shortcut.key, ctrl: true, shift: shortcut.shift ?? false, alt: shortcut.alt ?? false }
    if (shortcut.code) chord.code = shortcut.code
    return chord
  }
  const chord: KeyChord = { key: shortcut.key, mod: true, alt: shortcut.alt ?? false }
  // A symbol key leaves Shift open: some layouts need it to type "/" or "[".
  const symbol = !shortcut.code && shortcut.key.length === 1 && !/[a-z0-9]/i.test(shortcut.key)
  if (shortcut.shift !== undefined || !symbol) chord.shift = shortcut.shift ?? false
  if (shortcut.code) chord.code = shortcut.code
  return chord
}

/** Every app chord: swallowed behind dialogs even when nothing handles it. */
export const APP_SHORTCUT_CHORDS: readonly KeyChord[] = Object.values(APP_SHORTCUTS).map((s) => chordOf(s))

/** Human-readable label, e.g. ``⌘⇧D`` or ``Ctrl+Shift+D``. */
export function shortcutLabel(shortcut: AppShortcut, os: OS): string {
  return formatShortcut(shortcut.key, os, { shift: shortcut.shift, alt: shortcut.alt, ctrl: shortcut.ctrl })
}

/** Fire the shortcut as a synthetic key press (palette items, native menus). */
export function dispatchAppShortcut(shortcut: AppShortcut, os: OS): void {
  dispatchShortcutKey(shortcut.key.toLowerCase(), os, { shift: shortcut.shift, alt: shortcut.alt, code: shortcut.code, ctrl: shortcut.ctrl })
}
