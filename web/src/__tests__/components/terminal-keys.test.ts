import { describe, expect, it } from 'bun:test'

import { routeTerminalKey, terminalShortcut } from '@/components/Terminal/terminal-keys'

function keydown(key: string, mods: Partial<Pick<KeyboardEvent, 'metaKey' | 'ctrlKey' | 'shiftKey' | 'altKey' | 'code'>> = {}) {
  return new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...mods })
}

describe('routeTerminalKey — macOS', () => {
  it('leaves every key to xterm, which passes ⌘ chords on to the app shortcuts', () => {
    for (const event of [keydown('k', { metaKey: true }), keydown('c', { metaKey: true }), keydown('v', { metaKey: true }), keydown('k', { ctrlKey: true })]) {
      expect(routeTerminalKey(event, 'macos')).toBe(true)
      expect(event.defaultPrevented).toBe(false)
    }
  })

  it('sends Ctrl+Tab and Ctrl+Shift+Tab to the app for the dock tabs', () => {
    expect(routeTerminalKey(keydown('Tab', { ctrlKey: true }), 'macos')).toBe(false)
    expect(routeTerminalKey(keydown('Tab', { ctrlKey: true, shiftKey: true }), 'macos')).toBe(false)
    // Plain Tab is shell completion.
    expect(routeTerminalKey(keydown('Tab'), 'macos')).toBe(true)
  })
})

describe('routeTerminalKey — Windows/Linux', () => {
  it('keeps Ctrl+K and Ctrl+P from the shell so the palette and quick open still work', () => {
    for (const key of ['k', 'K', 'p']) {
      const event = keydown(key, { ctrlKey: true })
      expect(routeTerminalKey(event, 'linux')).toBe(false)
      // Not claimed here: the app's shortcut listener must still see it.
      expect(event.defaultPrevented).toBe(false)
    }
    expect(routeTerminalKey(keydown('k', { ctrlKey: true }), 'windows')).toBe(false)
  })

  it('keeps Ctrl+1–9 and Ctrl+Tab from the shell so the dock tab keys work', () => {
    expect(routeTerminalKey(keydown('1', { ctrlKey: true, code: 'Digit1' }), 'linux')).toBe(false)
    expect(routeTerminalKey(keydown('9', { ctrlKey: true, code: 'Digit9' }), 'windows')).toBe(false)
    // AZERTY prints "&" on Digit1: the physical key decides.
    expect(routeTerminalKey(keydown('&', { ctrlKey: true, code: 'Digit1' }), 'linux')).toBe(false)
    expect(routeTerminalKey(keydown('0', { ctrlKey: true, code: 'Digit0' }), 'linux')).toBe(true)
    expect(routeTerminalKey(keydown('Tab', { ctrlKey: true }), 'linux')).toBe(false)
    expect(routeTerminalKey(keydown('Tab', { ctrlKey: true, shiftKey: true }), 'linux')).toBe(false)
  })

  it('sends every other Ctrl chord to the shell', () => {
    for (const event of [keydown('c', { ctrlKey: true }), keydown('d', { ctrlKey: true }), keydown('w', { ctrlKey: true }), keydown('r', { ctrlKey: true })]) {
      expect(routeTerminalKey(event, 'linux')).toBe(true)
    }
    // Modified variants stay with the shell too.
    expect(routeTerminalKey(keydown('k', { ctrlKey: true, shiftKey: true }), 'linux')).toBe(true)
    expect(routeTerminalKey(keydown('p', { ctrlKey: true, altKey: true }), 'linux')).toBe(true)
  })
})

it('ignores keyup and keypress', () => {
  expect(routeTerminalKey(new KeyboardEvent('keyup', { key: 'k', ctrlKey: true }), 'linux')).toBe(true)
})

describe('terminalShortcut — find', () => {
  it('is ⌘F on macOS, taken from the app and never sent to the shell', () => {
    const event = keydown('f', { metaKey: true })
    expect(terminalShortcut(event, 'macos')).toBe('find')
    expect(routeTerminalKey(event, 'macos')).toBe(false)
    // Only plain ⌘F finds on macOS.
    expect(terminalShortcut(keydown('F', { metaKey: true, shiftKey: true }), 'macos')).toBeNull()
  })

  it('is Ctrl+Shift+F on Windows/Linux, while plain Ctrl+F reaches the shell', () => {
    for (const os of ['linux', 'windows'] as const) {
      const event = keydown('F', { ctrlKey: true, shiftKey: true })
      expect(terminalShortcut(event, os)).toBe('find')
      expect(routeTerminalKey(event, os)).toBe(false)
      const plain = keydown('f', { ctrlKey: true })
      expect(terminalShortcut(plain, os)).toBeNull()
      expect(routeTerminalKey(plain, os)).toBe(true)
    }
  })

  it('ignores the key when Alt is held or on keyup', () => {
    expect(terminalShortcut(keydown('f', { metaKey: true, altKey: true }), 'macos')).toBeNull()
    expect(terminalShortcut(new KeyboardEvent('keyup', { key: 'f', metaKey: true }), 'macos')).toBeNull()
  })
})

describe('terminalShortcut — copy and paste', () => {
  it('maps Ctrl+Shift+C and Ctrl+Shift+V on Windows/Linux', () => {
    for (const os of ['linux', 'windows'] as const) {
      expect(terminalShortcut(keydown('C', { ctrlKey: true, shiftKey: true }), os)).toBe('copy')
      expect(terminalShortcut(keydown('V', { ctrlKey: true, shiftKey: true }), os)).toBe('paste')
      expect(routeTerminalKey(keydown('C', { ctrlKey: true, shiftKey: true }), os)).toBe(false)
      // Plain Ctrl+C / Ctrl+V keep their shell meaning.
      expect(terminalShortcut(keydown('c', { ctrlKey: true }), os)).toBeNull()
      expect(routeTerminalKey(keydown('c', { ctrlKey: true }), os)).toBe(true)
      expect(routeTerminalKey(keydown('v', { ctrlKey: true }), os)).toBe(true)
    }
  })

  it('leaves ⌘C and ⌘V to the browser copy and paste events on macOS', () => {
    for (const key of ['c', 'v']) {
      expect(terminalShortcut(keydown(key, { metaKey: true }), 'macos')).toBeNull()
      expect(routeTerminalKey(keydown(key, { metaKey: true }), 'macos')).toBe(true)
    }
    // Ctrl+Shift+C on macOS is not a terminal copy.
    expect(terminalShortcut(keydown('C', { ctrlKey: true, shiftKey: true }), 'macos')).toBeNull()
  })
})

describe('terminalShortcut — add selection to chat', () => {
  it('is ⌘L / Ctrl+L only while text is selected', () => {
    expect(terminalShortcut(keydown('l', { metaKey: true }), 'macos', true)).toBe('add-to-chat')
    expect(terminalShortcut(keydown('l', { ctrlKey: true }), 'linux', true)).toBe('add-to-chat')
    expect(routeTerminalKey(keydown('l', { ctrlKey: true }), 'linux', true)).toBe(false)
    // Without a selection ⌘L stays the app's switcher and Ctrl+L clears the shell screen.
    expect(terminalShortcut(keydown('l', { metaKey: true }), 'macos', false)).toBeNull()
    expect(routeTerminalKey(keydown('l', { metaKey: true }), 'macos', false)).toBe(true)
    expect(routeTerminalKey(keydown('l', { ctrlKey: true }), 'linux', false)).toBe(true)
  })
})

describe('routeTerminalKey — layout keys on every OS', () => {
  for (const os of ['macos', 'linux', 'windows'] as const) {
    it(`keeps Control+backquote in the shell on ${os}: the app has no terminal key`, () => {
      expect(routeTerminalKey(keydown('`', { ctrlKey: true, code: 'Backquote' }), os)).toBe(true)
    })

    it(`gives Control+Alt+arrows (send the tab to a side) to the app on ${os}`, () => {
      for (const key of ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown']) {
        expect(routeTerminalKey(keydown(key, { ctrlKey: true, altKey: true }), os)).toBe(false)
      }
      // Alt+arrow and Ctrl+arrow stay with the shell (word moves).
      expect(routeTerminalKey(keydown('ArrowLeft', { altKey: true }), os)).toBe(true)
      expect(routeTerminalKey(keydown('ArrowLeft', { ctrlKey: true }), os)).toBe(true)
    })
  }
})
