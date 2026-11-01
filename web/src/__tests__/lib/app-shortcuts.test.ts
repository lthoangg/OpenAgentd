import { describe, expect, it } from 'bun:test'
import { readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { APP_SHORTCUTS, chordOf, shortcutLabel } from '@/lib/app-shortcuts'

const srcDir = fileURLToPath(new URL('../../', import.meta.url))
/** Only the table and the low-level helpers may spell out a key. */
const ALLOWED = new Set(['lib/app-shortcuts.ts', 'lib/keyboard-shortcut.ts'])
const LITERAL_SHORTCUT = /['"`]Mod\+|formatShortcut\(\s*['"`]|dispatchShortcutKey\(\s*['"`]/

describe('APP_SHORTCUTS', () => {
  it('assigns each key combination to exactly one command', () => {
    const combos = Object.values(APP_SHORTCUTS).map((s) =>
      `${'ctrl' in s && s.ctrl ? 'Ctrl+' : ''}${'alt' in s && s.alt ? 'Alt+' : ''}${'shift' in s && s.shift ? 'Shift+' : ''}${s.key.toUpperCase()}`)
    expect(new Set(combos).size).toBe(combos.length)
  })

  it('keeps bare ⌘S / Ctrl+S for Settings saves alone', () => {
    // Settings pages and editors bind Save inside the Settings modal (`within`);
    // the table lists it so the key is spelled out once. No other shortcut may
    // take bare S: an app-wide ⌘S would fire on every surface.
    const bareS = Object.entries(APP_SHORTCUTS)
      .filter(([, s]) => s.key.toUpperCase() === 'S' && !('shift' in s && s.shift))
      .map(([name]) => name)
    expect(bareS).toEqual(['save'])
    expect(chordOf(APP_SHORTCUTS.save)).toEqual({ key: 'S', mod: true, shift: false, alt: false })
    expect(shortcutLabel(APP_SHORTCUTS.save, 'macos')).toBe('⌘S')
    expect(shortcutLabel(APP_SHORTCUTS.save, 'windows')).toBe('Ctrl+S')
  })

  it('registers every shortcut on the platform primary modifier', () => {
    expect(chordOf(APP_SHORTCUTS.maximizeDock)).toEqual({ key: 'D', mod: true, shift: true, alt: false })
    expect(chordOf(APP_SHORTCUTS.newSession)).toEqual({ key: 'N', mod: true, shift: false, alt: false })
    expect(chordOf(APP_SHORTCUTS.previousPrompt)).toEqual({ key: 'ArrowUp', mod: true, shift: false, alt: true })
    expect(chordOf(APP_SHORTCUTS.terminal)).toEqual({ key: '`', code: 'Backquote', mod: true, shift: true, alt: false })
  })

  it('keeps the terminal toggle on the Control key itself, as in editors', () => {
    expect(chordOf(APP_SHORTCUTS.toggleTerminal)).toEqual({ key: '`', code: 'Backquote', ctrl: true, shift: false, alt: false })
    expect(shortcutLabel(APP_SHORTCUTS.toggleTerminal, 'macos')).toBe('⌃`')
    expect(shortcutLabel(APP_SHORTCUTS.toggleTerminal, 'linux')).toBe('Ctrl+`')
  })

  it('has the layout shortcuts of the View menu', () => {
    expect(shortcutLabel(APP_SHORTCUTS.splitDock, 'macos')).toBe('⌘\\')
    expect(shortcutLabel(APP_SHORTCUTS.focusMode, 'macos')).toBe('⌘⇧F')
    expect(shortcutLabel(APP_SHORTCUTS.findInSession, 'windows')).toBe('Ctrl+F')
  })

  it('formats labels for each platform', () => {
    expect(shortcutLabel(APP_SHORTCUTS.maximizeDock, 'macos')).toBe('⌘⇧D')
    expect(shortcutLabel(APP_SHORTCUTS.settings, 'windows')).toBe('Ctrl+,')
    expect(shortcutLabel(APP_SHORTCUTS.previousPrompt, 'macos')).toBe('⌥⌘↑')
    expect(shortcutLabel(APP_SHORTCUTS.nextPrompt, 'windows')).toBe('Ctrl+Alt+↓')
  })

  it('is the only place a shortcut key is spelled out', () => {
    const offenders: string[] = []
    for (const path of readdirSync(srcDir, { recursive: true, encoding: 'utf8' })) {
      if (path.startsWith('__tests__') || !/\.tsx?$/.test(path) || ALLOWED.has(path)) continue
      readFileSync(srcDir + path, 'utf8').split('\n').forEach((line, index) => {
        if (LITERAL_SHORTCUT.test(line)) offenders.push(`${path}:${index + 1}`)
      })
    }
    expect(offenders).toEqual([])
  })
})
