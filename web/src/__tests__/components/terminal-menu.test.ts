import { describe, expect, it } from 'bun:test'

import { terminalMenuItems } from '@/components/Terminal/terminal-menu'

describe('terminalMenuItems', () => {
  it('offers Select Text first on touch, where xterm cannot select part of the output', () => {
    const items = terminalMenuItems({ touch: true, hasSelection: false, os: 'ios' })
    expect(items.map((item) => item.action)).toEqual([
      'select-text', 'copy', 'paste', 'select-all', 'find', 'add-to-chat', 'clear',
    ])
    expect(items.every((item) => item.keys === undefined)).toBe(true)
  })

  it('has the same items without Select Text for a pointer', () => {
    const items = terminalMenuItems({ touch: false, hasSelection: true, os: 'macos' })
    expect(items.map((item) => item.action)).toEqual(['copy', 'paste', 'select-all', 'find', 'add-to-chat', 'clear'])
  })

  it('spells the terminal keys for the platform', () => {
    const keysOf = (os: 'macos' | 'windows') =>
      Object.fromEntries(terminalMenuItems({ touch: false, hasSelection: true, os }).map((item) => [item.action, item.keys]))
    expect(keysOf('macos')).toMatchObject({ copy: '⌘C', paste: '⌘V', find: '⌘F', 'add-to-chat': '⌘L' })
    // Plain Ctrl+C/V/F stay with the shell elsewhere.
    expect(keysOf('windows')).toMatchObject({ copy: 'Ctrl+Shift+C', paste: 'Ctrl+Shift+V', find: 'Ctrl+Shift+F', 'add-to-chat': 'Ctrl+L' })
  })

  it('disables Copy and Add to chat without a selection', () => {
    const disabled = terminalMenuItems({ touch: false, hasSelection: false, os: 'linux' })
      .filter((item) => item.disabled)
      .map((item) => item.action)
    expect(disabled).toEqual(['copy', 'add-to-chat'])
  })
})
