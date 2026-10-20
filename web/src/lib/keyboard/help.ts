/**
 * What the Keyboard Shortcuts sheet lists: the app table plus the keys that
 * only work in one area (composer, terminal, Preview, dialogs and viewers).
 * Labels come from the same chords the handlers match, per platform.
 */
import type { OS } from '@/hooks/use-platform'
import { APP_SHORTCUTS, NEXT_DOCK_TAB_CHORD, PREV_DOCK_TAB_CHORD, chordOf, type AppShortcutName } from '@/lib/app-shortcuts'

import { formatChord, type KeyChord } from './chord'

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
  const mac = os === 'macos'
  const appOnly = (label: string) => (desktopApp ? label : `${label} (desktop app)`)

  return [
    {
      title: 'App',
      entries: [
        app('newSession', 'New session'),
        app('commandPalette', 'Command palette'),
        app('quickOpen', 'Quick Open'),
        app('settings', 'Settings'),
        app('shortcutsHelp', 'Keyboard shortcuts'),
        app('sidebar', 'Toggle sidebar'),
        app('sessionSettings', 'Session settings'),
        app('historyBack', 'Back'),
        app('historyForward', 'Forward'),
      ],
    },
    {
      title: 'Moving around',
      entries: [
        keys('Next and previous control', { key: 'Tab' }, { key: 'Tab', shift: true }),
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
        keys('Send and interrupt the agent', { key: 'Enter', mod: true }),
        keys('Send after the current turn', { key: 'Enter', alt: true }),
        keys('Switch Plan and Code mode', { key: 'Tab' }),
        keys('Earlier and later sent messages', { key: 'ArrowUp' }, { key: 'ArrowDown' }),
        keys('Minimize the input', { key: 'Escape' }),
        app('previousPrompt', 'Previous prompt'),
        app('nextPrompt', 'Next prompt'),
        app('tasks', 'Task list'),
      ],
    },
    {
      title: 'Review dock',
      entries: [
        app('workspaceFiles', 'Show or hide the review dock'),
        app('openGit', 'Open Git'),
        app('maximizeDock', 'Maximize the review dock'),
        app('closeTab', 'Close tab'),
        keys(appOnly('Dock tab 1 to 8, and the last'), chordOf(APP_SHORTCUTS.dockTab1), chordOf(APP_SHORTCUTS.dockTab9)),
        keys(appOnly('Next and previous dock tab'), NEXT_DOCK_TAB_CHORD, PREV_DOCK_TAB_CHORD),
        keys('Move the focused dock tab', { key: 'ArrowLeft', alt: true, shift: true }, { key: 'ArrowRight', alt: true, shift: true }),
        app('terminal', 'Open terminal'),
      ],
    },
    {
      title: 'Terminal',
      entries: [
        // Elsewhere Ctrl+K belongs to the shell.
        ...(mac ? [keys('Clear the terminal', { key: 'K', mod: true })] : []),
        keys('Close the terminal (asks while its shell runs)', { key: 'W', mod: true }),
      ],
    },
    {
      title: 'Preview',
      entries: [
        keys('Toggle Design picking', { key: 'C', code: 'KeyC', alt: true }),
        keys('Stop picking', { key: 'Escape' }),
      ],
    },
    {
      title: 'Dialogs and viewers',
      entries: [
        keys('Close the top dialog, menu or viewer', { key: 'Escape' }),
        keys('Previous and next file', { key: 'ArrowLeft' }, { key: 'ArrowRight' }),
        keys('Open and leave a Command Palette list', { key: 'ArrowRight' }, { key: 'ArrowLeft' }),
        keys('Zoom in and out', { key: '+' }, { key: '-' }),
        keys('Reset zoom', { key: '0' }),
        keys('Save settings', { key: 'S', mod: true }),
      ],
    },
  ]
}
