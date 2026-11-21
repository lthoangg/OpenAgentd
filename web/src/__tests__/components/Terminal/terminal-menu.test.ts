import { describe, expect, it } from 'bun:test'

import { terminalMenuItems, TOUCH_MENU_ITEMS } from '@/components/Terminal/terminal-menu'

describe('TOUCH_MENU_ITEMS', () => {
  it('is Select Text, Paste, Find and Clear: nothing that needs a selection xterm cannot make by touch', () => {
    expect(TOUCH_MENU_ITEMS.map((item) => item.action)).toEqual(['select-text', 'paste', 'find', 'clear'])
    expect(TOUCH_MENU_ITEMS.every((item) => item.keys === undefined && !item.disabled)).toBe(true)
  })
})

describe('terminalMenuItems (pointer)', () => {
  it('has the full menu without Select Text', () => {
    const items = terminalMenuItems({ hasSelection: true, os: 'macos' })
    expect(items.map((item) => item.action)).toEqual(['copy', 'paste', 'select-all', 'find', 'add-to-chat', 'clear'])
  })

  it('spells the terminal keys for the platform', () => {
    const keysOf = (os: 'macos' | 'windows') =>
      Object.fromEntries(terminalMenuItems({ hasSelection: true, os }).map((item) => [item.action, item.keys]))
    expect(keysOf('macos')).toMatchObject({ copy: '⌘C', paste: '⌘V', find: '⌘F', 'add-to-chat': '⌘L' })
    // Plain Ctrl+C/V/F stay with the shell elsewhere.
    expect(keysOf('windows')).toMatchObject({ copy: 'Ctrl+Shift+C', paste: 'Ctrl+Shift+V', find: 'Ctrl+Shift+F', 'add-to-chat': 'Ctrl+L' })
  })

  it('disables Copy and Add to chat without a selection', () => {
    const disabled = terminalMenuItems({ hasSelection: false, os: 'linux' })
      .filter((item) => item.disabled)
      .map((item) => item.action)
    expect(disabled).toEqual(['copy', 'add-to-chat'])
  })
})
