import { describe, expect, it } from 'bun:test'
import { readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { APP_SHORTCUTS, NEXT_DOCK_TAB_CHORD, PREV_DOCK_TAB_CHORD, chordOf, dockTabStepKeys, promptStepKeys, shortcutLabel } from '@/lib/app-shortcuts'
import { isPrimaryShortcut } from '@/lib/keyboard-shortcut'
import { formatChord } from '@/lib/keyboard/chord'
import { HISTORY_ALT_BACK, HISTORY_ALT_FORWARD, usesAltArrowHistory } from '@/lib/keyboard/history-keys'

const srcDir = fileURLToPath(new URL('../../', import.meta.url))
/** Only the table and the low-level helpers may spell out a key. */
const ALLOWED = new Set(['lib/app-shortcuts.ts', 'lib/keyboard-shortcut.ts'])
const LITERAL_SHORTCUT = /['"`]Mod\+|formatShortcut\(\s*['"`]|dispatchShortcutKey\(\s*['"`]/

describe('APP_SHORTCUTS', () => {
  // Compared as each OS presses them: off macOS the primary modifier is the
  // Control key, so a ``mod`` chord and a ``ctrl`` chord can be the same keys.
  for (const os of ['macos', 'windows', 'linux'] as const) {
    it(`assigns each key combination to exactly one command on ${os}`, () => {
      const prompts = promptStepKeys(os)
      const tabs = dockTabStepKeys(os)
      const chords = [
        ...Object.values(APP_SHORTCUTS).map((s) => chordOf(s)),
        prompts.previous, prompts.next,
        NEXT_DOCK_TAB_CHORD, PREV_DOCK_TAB_CHORD, tabs.next, tabs.prev,
        ...(usesAltArrowHistory(os) ? [HISTORY_ALT_BACK, HISTORY_ALT_FORWARD] : []),
      ]
      const combos = chords.map((chord) => formatChord(chord, os))
      const twice = combos.filter((combo, index) => combos.indexOf(combo) !== index)
      expect(twice).toEqual([])
    })
  }

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

  // An iPad's hardware keyboard drives apps with ⌘, as a Mac's does; Ctrl
  // shortcuts there read wrong and fight the system's own ⌘ set.
  it('uses ⌘ on iPad and iPhone keyboards, as on a Mac', () => {
    expect(shortcutLabel(APP_SHORTCUTS.newSession, 'ios')).toBe('⌘N')
    expect(isPrimaryShortcut(new KeyboardEvent('keydown', { key: 'n', metaKey: true }), 'ios')).toBe(true)
    expect(isPrimaryShortcut(new KeyboardEvent('keydown', { key: 'n', ctrlKey: true }), 'ios')).toBe(false)
    expect(shortcutLabel(APP_SHORTCUTS.newSession, 'android')).toBe('Ctrl+N')
  })

  it('registers every shortcut on the platform primary modifier', () => {
    expect(chordOf(APP_SHORTCUTS.maximizeDock)).toEqual({ key: 'D', mod: true, shift: true, alt: false })
    expect(chordOf(APP_SHORTCUTS.newSession)).toEqual({ key: 'N', mod: true, shift: false, alt: false })
  })

  it('steps prompts with ⌥⌘↑ on macOS and Alt+↑ elsewhere', () => {
    expect(formatChord(promptStepKeys('macos').previous, 'macos')).toBe('⌥⌘↑')
    expect(formatChord(promptStepKeys('ios').next, 'ios')).toBe('⌥⌘↓')
    expect(formatChord(promptStepKeys('windows').previous, 'windows')).toBe('Alt+↑')
    expect(formatChord(promptStepKeys('linux').next, 'linux')).toBe('Alt+↓')
  })

  it('opens the run picker on ⌘. (Ctrl+.), matched on the physical key', () => {
    expect(chordOf(APP_SHORTCUTS.sessionSettings)).toEqual({ key: '.', code: 'Period', mod: true, shift: false, alt: false })
    expect(shortcutLabel(APP_SHORTCUTS.sessionSettings, 'macos')).toBe('⌘.')
    expect(shortcutLabel(APP_SHORTCUTS.sessionSettings, 'windows')).toBe('Ctrl+.')
  })

  // Terminals open from the palette (Open Terminal) and the Review panel's
  // "+" menu and launcher; no key of their own.
  it('has no terminal key, with or without Shift', () => {
    expect(Object.keys(APP_SHORTCUTS).filter((name) => /terminal/i.test(name))).toEqual([])
    const codes: (string | undefined)[] = Object.values(APP_SHORTCUTS).map((s) => ('code' in s ? s.code : undefined))
    expect(codes).not.toContain('Backquote')
  })

  it('sends the focused tab to a side with Control+Option/Alt and an arrow', () => {
    expect(chordOf(APP_SHORTCUTS.splitTabRight)).toEqual({ key: 'ArrowRight', ctrl: true, shift: false, alt: true })
    expect(shortcutLabel(APP_SHORTCUTS.splitTabLeft, 'macos')).toBe('⌃⌥←')
    expect(shortcutLabel(APP_SHORTCUTS.splitTabDown, 'macos')).toBe('⌃⌥↓')
    expect(shortcutLabel(APP_SHORTCUTS.splitTabUp, 'windows')).toBe('Ctrl+Alt+↑')
    expect(shortcutLabel(APP_SHORTCUTS.splitTabRight, 'linux')).toBe('Ctrl+Alt+→')
  })

  it('has the layout shortcuts of the View menu', () => {
    expect(shortcutLabel(APP_SHORTCUTS.splitDock, 'macos')).toBe('⌘\\')
    expect(shortcutLabel(APP_SHORTCUTS.splitDockDown, 'macos')).toBe('⌘⇧\\')
    expect(chordOf(APP_SHORTCUTS.splitDockDown)).toEqual({ key: '\\', code: 'Backslash', mod: true, shift: true, alt: false })
    // Focus Mode is gone; ⌘⇧F is free.
    expect('focusMode' in APP_SHORTCUTS).toBe(false)
    expect(shortcutLabel(APP_SHORTCUTS.findInSession, 'windows')).toBe('Ctrl+F')
  })

  it('formats labels for each platform', () => {
    expect(shortcutLabel(APP_SHORTCUTS.maximizeDock, 'macos')).toBe('⌘⇧D')
    expect(shortcutLabel(APP_SHORTCUTS.settings, 'windows')).toBe('Ctrl+,')
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
