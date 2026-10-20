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
    expect(groups).toEqual(['App', 'Moving around', 'Chat', 'Review dock', 'Terminal', 'Preview', 'Dialogs and viewers'])
    expect(find('macos', 'Close tab')?.keys).toEqual(['⌘W'])
    expect(find('windows', 'Close tab')?.keys).toEqual(['Ctrl+W'])
    expect(find('macos', 'Keyboard shortcuts')?.keys).toEqual(['⌘/'])
    expect(find('macos', 'Toggle Design picking')?.keys).toEqual(['⌥C'])
    expect(find('macos', 'Close the top dialog, menu or viewer')?.keys).toEqual(['Esc'])
    expect(find('macos', 'Open and leave a Command Palette list')?.keys).toEqual(['→', '←'])
  })

  it('lists the focus and dock tab keys, marking the ones browsers keep', () => {
    expect(find('macos', 'Menu for the focused item')?.keys).toEqual(['⇧F10'])
    expect(find('macos', 'Open Git')?.keys).toEqual(['⌘⇧G'])
    expect(find('macos', 'Move the focused dock tab')?.keys).toEqual(['⌥⇧←', '⌥⇧→'])
    expect(find('macos', 'Next and previous dock tab (desktop app)')?.keys).toEqual(['⌃Tab', '⌃⇧Tab'])
    expect(find('windows', 'Dock tab 1 to 8, and the last (desktop app)')?.keys).toEqual(['Ctrl+1', 'Ctrl+9'])
    expect(find('macos', 'Next and previous dock tab', true)?.keys).toEqual(['⌃Tab', '⌃⇧Tab'])
  })

  it('lists every app shortcut once', () => {
    const labels = shortcutHelp('linux').flatMap((group) => group.entries.map((entry) => entry.label))
    expect(new Set(labels).size).toBe(labels.length)
  })
})
