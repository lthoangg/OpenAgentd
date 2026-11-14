import { describe, expect, it } from 'bun:test'
import { ariaShortcut, holdsShortcutModifier, shortcutLabel } from '@/tray/shortcuts'

const held = (keys: Partial<Record<'metaKey' | 'ctrlKey' | 'altKey' | 'shiftKey', boolean>>) => ({
  metaKey: false,
  ctrlKey: false,
  altKey: false,
  shiftKey: false,
  ...keys,
})

describe('tray shortcuts', () => {
  it('acts on the modifier its hint names, and on no other', () => {
    expect(shortcutLabel('q', 'macos')).toBe('⌘Q')
    expect(ariaShortcut('r', 'macos')).toBe('Meta+R')
    expect(holdsShortcutModifier(held({ metaKey: true }), 'macos')).toBe(true)
    expect(holdsShortcutModifier(held({ ctrlKey: true }), 'macos')).toBe(false)
    expect(holdsShortcutModifier(held({ metaKey: true, shiftKey: true }), 'macos')).toBe(false)

    expect(shortcutLabel('q', 'windows')).toBe('Ctrl+Q')
    expect(ariaShortcut('r', 'windows')).toBe('Control+R')
    expect(holdsShortcutModifier(held({ ctrlKey: true }), 'windows')).toBe(true)
    expect(holdsShortcutModifier(held({ metaKey: true }), 'windows')).toBe(false)
    expect(holdsShortcutModifier(held({ ctrlKey: true, altKey: true }), 'windows')).toBe(false)
  })
})
