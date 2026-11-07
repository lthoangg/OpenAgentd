import { describe, expect, it } from 'bun:test'

import { formatChord } from '@/lib/keyboard/chord'
import { shortcutHelp } from '@/lib/keyboard/help'

const find = (os: 'macos' | 'windows', label: string, desktopApp = false) =>
  shortcutHelp(os, { desktopApp }).flatMap((group) => group.entries).find((entry) => entry.label === label)

describe('formatChord', () => {
  it('formats any chord for each platform', () => {
    expect(formatChord({ key: 'W', mod: true }, 'macos')).toBe('⌘W')
    expect(formatChord({ key: 'W', mod: true }, 'windows')).toBe('Ctrl+W')
    expect(formatChord({ key: 'Enter', alt: true }, 'macos')).toBe('⌥↵')
    expect(formatChord({ key: 'Enter', shift: true }, 'linux')).toBe('Shift+Enter')
    expect(formatChord({ key: 'C', code: 'KeyC', alt: true }, 'windows')).toBe('Alt+C')
    expect(formatChord({ key: 'Escape' }, 'macos')).toBe('Esc')
    expect(formatChord({ key: 'Tab', ctrl: true }, 'macos')).toBe('⌃Tab')
    expect(formatChord({ key: 'Tab', ctrl: true, shift: true }, 'windows')).toBe('Ctrl+Shift+Tab')
    expect(formatChord({ key: 'Backspace', mod: true }, 'macos')).toBe('⌘⌫')
  })
})

describe('shortcutHelp', () => {
  it('groups the app table and the keys that live in one area', () => {
    const groups = shortcutHelp('macos').map((group) => group.title)
    expect(groups).toEqual(['App', 'Moving around', 'Chat', 'Review panel', 'Terminal', 'Preview', 'Dialogs and viewers'])
    expect(shortcutHelp('macos', { desktopApp: true }).map((group) => group.title))
      .toEqual(['App', 'Moving around', 'Chat', 'Review panel', 'Terminal', 'Preview', 'Dialogs and viewers', 'Desktop app', 'From any app (when Global Shortcuts is on)'])
    expect(find('macos', 'Close tab')?.keys).toEqual(['⌘W'])
    expect(find('macos', 'Open workspace')?.keys).toEqual(['⌘O'])
    // The file finder is "Find file", not "Quick Open"
    expect(find('macos', 'Find file')?.keys).toEqual(['⌘P'])
    expect(find('macos', 'Quick Open')).toBeUndefined()
    expect(find('macos', 'Show or hide the Review panel')?.keys).toEqual(['⌘D'])
    expect(find('macos', 'Maximize the Review panel')?.keys).toEqual(['⌘⇧D'])
    expect(find('windows', 'Close tab')?.keys).toEqual(['Ctrl+W'])
    expect(find('macos', 'Keyboard shortcuts')?.keys).toEqual(['⌘/'])
    expect(find('macos', 'Comment on an element (toggle)')?.keys).toEqual(['⌥C'])
    expect(find('macos', 'Close the top dialog, menu or viewer')?.keys).toEqual(['Esc'])
    expect(find('macos', 'Open and leave a Command Palette list')?.keys).toEqual(['→', '←'])
  })

  it('lists the focus and dock tab keys, marking the ones browsers keep', () => {
    expect(find('macos', 'Menu for the focused item')?.keys).toEqual(['⇧F10'])
    expect(find('macos', 'Open Git')?.keys).toEqual(['⌘⇧G'])
    expect(find('macos', 'Move the focused tab')?.keys).toEqual(['⌥⇧←', '⌥⇧→'])
    expect(find('macos', 'Next and previous tab (desktop app)')?.keys).toEqual(['⌃Tab', '⌃⇧Tab', '⌘⇧]', '⌘⇧['])
    expect(find('windows', 'Tab 1 to 8, and the last (desktop app)')?.keys).toEqual(['Ctrl+1', 'Ctrl+9'])
    expect(find('macos', 'Next and previous tab', true)?.keys).toEqual(['⌃Tab', '⌃⇧Tab', '⌘⇧]', '⌘⇧['])
    // Elsewhere the platform's own pair.
    expect(find('windows', 'Next and previous tab', true)?.keys).toEqual(['Ctrl+Tab', 'Ctrl+Shift+Tab', 'Ctrl+PageDown', 'Ctrl+PageUp'])
  })

  it('lists every app shortcut once', () => {
    const labels = shortcutHelp('linux').flatMap((group) => group.entries.map((entry) => entry.label))
    expect(new Set(labels).size).toBe(labels.length)
  })

  it('lists Search sessions on ⌘⇧F', () => {
    expect(find('macos', 'Search sessions')?.keys).toEqual(['⌘⇧F'])
    expect(find('windows', 'Search sessions')?.keys).toEqual(['Ctrl+Shift+F'])
  })

  it('lists the layout keys: splits, terminals, find, areas', () => {
    expect(find('macos', 'Split Review panel right')?.keys).toEqual(['⌘\\'])
    expect(find('macos', 'Split Review panel down')?.keys).toEqual(['⌘⇧\\'])
    expect(find('windows', 'Split Review panel down')?.keys).toEqual(['Ctrl+Shift+\\'])
    // No terminal key: the palette and the panel's "+" menu open terminals.
    expect(find('macos', 'Show the terminal, or start one')).toBeUndefined()
    expect(find('macos', 'Focus mode')).toBeUndefined()
    expect(find('macos', 'Find in session (from the chat)')?.keys).toEqual(['⌘F'])
    expect(find('macos', 'Next and previous area')?.keys).toEqual(['F6', '⇧F6'])
    // The composer no longer minimizes.
    expect(find('macos', 'Minimize the input')).toBeUndefined()
  })

  it('lists Alt+arrows for back and forward off macOS only', () => {
    expect(find('windows', 'Back')?.keys).toEqual(['Ctrl+[', 'Alt+←'])
    expect(find('windows', 'Forward')?.keys).toEqual(['Ctrl+]', 'Alt+→'])
    expect(find('macos', 'Back')?.keys).toEqual(['⌘['])
  })

  it('lists the sidebar row keys', () => {
    expect(find('macos', 'Previous and next sidebar row')?.keys).toEqual(['↑', '↓'])
    expect(find('macos', 'First and last sidebar row')?.keys).toEqual(['Home', 'End'])
  })

  it('lists the keys a terminal really has, and no ⌘K clear (⌘K opens the palette)', () => {
    expect(find('macos', 'Clear the terminal')).toBeUndefined()
    expect(find('macos', 'Find in the terminal')?.keys).toEqual(['⌘F'])
    expect(find('windows', 'Find in the terminal')?.keys).toEqual(['Ctrl+Shift+F'])
    expect(find('windows', 'Add the selected text to the chat')?.keys).toEqual(['Ctrl+L'])
    expect(find('windows', 'Copy and paste')?.keys).toEqual(['Ctrl+Shift+C', 'Ctrl+Shift+V'])
    expect(find('macos', 'Copy and paste')).toBeUndefined()
  })

  it('names the send keys as the Send menu does', () => {
    expect(find('macos', 'Stop & send')?.keys).toEqual(['⌘↵'])
    expect(find('windows', 'Queue until done')?.keys).toEqual(['Alt+Enter'])
  })

  it('lists the desktop app window keys only in the desktop app', () => {
    expect(find('macos', 'New window', true)?.keys).toEqual(['⌘⇧N'])
    expect(find('windows', 'Zoom the app in and out', true)?.keys).toEqual(['Ctrl+=', 'Ctrl+-'])
    expect(find('macos', 'Actual size', true)?.keys).toEqual(['⌘0'])
    expect(find('macos', 'New window')).toBeUndefined()
    expect(find('macos', 'Zoom an image in and out')?.keys).toEqual(['+', '-'])
  })

  it('lists the opt-in global shortcuts of the desktop app', () => {
    expect(find('macos', 'Show OpenAgentd', true)?.keys).toEqual(['⌥⌘O'])
    expect(find('windows', 'Next session that needs you', true)?.keys).toEqual(['Ctrl+Alt+J'])
    // A browser has no global shortcuts to list.
    expect(find('windows', 'Show OpenAgentd')).toBeUndefined()
  })
})
