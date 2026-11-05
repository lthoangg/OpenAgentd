/**
 * What the Keyboard Shortcuts sheet lists: the app table plus the keys that
 * only work in one area (composer, terminal, Preview, dialogs and viewers).
 * Labels come from the same chords the handlers match, per platform.
 */
import type { OS } from '@/hooks/use-platform'
import { APP_SHORTCUTS, NEXT_DOCK_TAB_CHORD, PREV_DOCK_TAB_CHORD, chordOf, dockTabStepKeys, type AppShortcutName } from '@/lib/app-shortcuts'
import { NEXT_REGION_CHORD, PREV_REGION_CHORD } from '@/lib/focus-regions'
import { isPrimaryModifierOS } from '@/lib/keyboard-shortcut'

import { formatChord, type KeyChord } from './chord'
import { HISTORY_ALT_BACK, HISTORY_ALT_FORWARD, usesAltArrowHistory } from './history-keys'

export interface ShortcutHelpEntry {
  label: string
  keys: string[]
}

export interface ShortcutHelpGroup {
  title: string
  entries: ShortcutHelpEntry[]
}

export interface ShortcutHelpOptions {
  /** In the desktop app: browsers keep ⌃Tab and ⌘1–9 for their own tabs. */
  desktopApp?: boolean
}

export function shortcutHelp(os: OS, { desktopApp = false }: ShortcutHelpOptions = {}): ShortcutHelpGroup[] {
  const app = (name: AppShortcutName, label: string): ShortcutHelpEntry => ({ label, keys: [formatChord(chordOf(APP_SHORTCUTS[name]), os)] })
  const keys = (label: string, ...chords: KeyChord[]): ShortcutHelpEntry => ({ label, keys: chords.map((chord) => formatChord(chord, os)) })
  // iPadOS with a keyboard follows macOS: ⌘ is its primary modifier too.
  const mac = isPrimaryModifierOS(os)
  const appOnly = (label: string) => (desktopApp ? label : `${label} (desktop app)`)
  const altHistory = usesAltArrowHistory(os)
  const stepKeys = dockTabStepKeys(os)

  return [
    {
      title: 'App',
      entries: [
        app('newSession', 'New session'),
        app('openWorkspace', 'Open workspace'),
        app('commandPalette', 'Command palette'),
        app('quickOpen', 'Find file'),
        app('switchWorkspace', 'Switch workspace/session'),
        app('workspaceSessions', 'Sessions in this workspace'),
        app('settings', 'Settings'),
        app('shortcutsHelp', 'Keyboard shortcuts'),
        app('sidebar', 'Toggle sidebar'),
        app('sessionSettings', 'Model and thinking'),
        altHistory ? keys('Back', chordOf(APP_SHORTCUTS.historyBack), HISTORY_ALT_BACK) : app('historyBack', 'Back'),
        altHistory ? keys('Forward', chordOf(APP_SHORTCUTS.historyForward), HISTORY_ALT_FORWARD) : app('historyForward', 'Forward'),
      ],
    },
    {
      title: 'Moving around',
      entries: [
        keys('Next and previous control', { key: 'Tab' }, { key: 'Tab', shift: true }),
        keys('Next and previous area', NEXT_REGION_CHORD, PREV_REGION_CHORD),
        keys('Previous and next sidebar row', { key: 'ArrowUp' }, { key: 'ArrowDown' }),
        keys('First and last sidebar row', { key: 'Home' }, { key: 'End' }),
        keys('Collapse and expand a sidebar workspace', { key: 'ArrowLeft' }, { key: 'ArrowRight' }),
        keys('Rename the focused item', { key: 'F2' }),
        keys('Delete the focused item', { key: 'Delete' }, { key: 'Backspace', mod: true }),
        keys('Menu for the focused item', { key: 'F10', shift: true }),
      ],
    },
    {
      title: 'Chat',
      entries: [
        app('focusChat', 'Focus the message input'),
        keys('Send', { key: 'Enter' }),
        keys('New line', { key: 'Enter', shift: true }),
        // Named as in the Send menu while a turn runs.
        keys('Stop & send', { key: 'Enter', mod: true }),
        keys('Queue until done', { key: 'Enter', alt: true }),
        keys('Switch Plan and Code mode', { key: 'Tab' }),
        keys('Earlier and later sent messages', { key: 'ArrowUp' }, { key: 'ArrowDown' }),
        app('findInSession', 'Find in session (from the chat)'),
        app('previousPrompt', 'Previous prompt'),
        app('nextPrompt', 'Next prompt'),
        app('tasks', 'Tasks'),
      ],
    },
    {
      title: 'Review panel',
      entries: [
        app('workspaceFiles', 'Show or hide the Review panel'),
        app('splitDock', 'Split Review panel right'),
        app('splitDockDown', 'Split Review panel down'),
        keys('Send the focused tab left, right, up or down', chordOf(APP_SHORTCUTS.splitTabLeft), chordOf(APP_SHORTCUTS.splitTabRight), chordOf(APP_SHORTCUTS.splitTabUp), chordOf(APP_SHORTCUTS.splitTabDown)),
        app('openGit', 'Open Git'),
        app('maximizeDock', 'Maximize the Review panel'),
        app('closeTab', 'Close tab'),
        keys(appOnly('Tab 1 to 8, and the last'), chordOf(APP_SHORTCUTS.dockTab1), chordOf(APP_SHORTCUTS.dockTab9)),
        keys(
          appOnly('Next and previous tab'),
          NEXT_DOCK_TAB_CHORD,
          PREV_DOCK_TAB_CHORD,
          stepKeys.next,
          stepKeys.prev,
        ),
        keys('Move the focused tab', { key: 'ArrowLeft', alt: true, shift: true }, { key: 'ArrowRight', alt: true, shift: true }),
      ],
    },
    {
      title: 'Terminal',
      entries: [
        // The terminal's own chords (components/Terminal/terminal-keys.ts).
        // Off macOS plain Ctrl+F, Ctrl+C and Ctrl+V stay with the shell.
        keys('Find in the terminal', mac ? { key: 'F', mod: true } : { key: 'F', mod: true, shift: true }),
        keys('Add the selected text to the chat', { key: 'L', mod: true }),
        ...(mac ? [] : [keys('Copy and paste', { key: 'C', mod: true, shift: true }, { key: 'V', mod: true, shift: true })]),
        // A focused shell keeps Ctrl+W off macOS; the key works from the tab.
        keys(mac ? 'Close the terminal (asks while its shell runs)' : 'Close the terminal from its tab (asks while its shell runs)', { key: 'W', mod: true }),
      ],
    },
    {
      title: 'Preview',
      entries: [
        keys('Comment on an element (toggle)', { key: 'C', code: 'KeyC', alt: true }),
        keys('Stop commenting', { key: 'Escape' }),
      ],
    },
    {
      title: 'Dialogs and viewers',
      entries: [
        keys('Close the top dialog, menu or viewer', { key: 'Escape' }),
        keys('Previous and next file', { key: 'ArrowLeft' }, { key: 'ArrowRight' }),
        keys('Open and leave a Command Palette list', { key: 'ArrowRight' }, { key: 'ArrowLeft' }),
        keys('Zoom an image in and out', { key: '+' }, { key: '-' }),
        keys('Reset the image zoom', { key: '0' }),
        app('save', 'Save settings'),
      ],
    },
    // The desktop app's menu keys (desktop/src-tauri/src/menu.rs).
    ...(desktopApp
      ? [{
          title: 'Desktop app',
          entries: [
            keys('New window', { key: 'N', mod: true, shift: true }),
            keys('Zoom the app in and out', { key: '=', mod: true }, { key: '-', mod: true }),
            keys('Actual size', { key: '0', mod: true }),
          ],
        }]
      : []),
    // The desktop app's global shortcuts (desktop/src-tauri/src/global_shortcuts.rs):
    // off until "Global Shortcuts" is ticked in the OpenAgentd menu.
    ...(desktopApp
      ? [{
          title: 'From any app (when Global Shortcuts is on)',
          entries: [
            keys('Show OpenAgentd', { key: 'O', mod: true, alt: true }),
            keys('Next session that needs you', { key: 'J', mod: true, alt: true }),
          ],
        }]
      : []),
  ]
}
