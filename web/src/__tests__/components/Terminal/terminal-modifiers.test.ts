import { describe, expect, it } from 'bun:test'

import { applyModifiers, stickyModifierTransform, type StickyModifiers } from '@/components/Terminal/terminal-modifiers'

const CTRL = { ctrl: true, alt: false }
const ALT = { ctrl: false, alt: true }
const BOTH = { ctrl: true, alt: true }

describe('applyModifiers', () => {
  it('sends input as typed with nothing armed', () => {
    expect(applyModifiers('a', { ctrl: false, alt: false })).toBe('a')
    expect(applyModifiers('hello', { ctrl: false, alt: false })).toBe('hello')
  })

  it('turns a character into its control code with Ctrl', () => {
    expect(applyModifiers('c', CTRL)).toBe('\x03')
    expect(applyModifiers('R', CTRL)).toBe('\x12')
    expect(applyModifiers('[', CTRL)).toBe('\x1b')
    expect(applyModifiers('?', CTRL)).toBe('\x7f')
    expect(applyModifiers('@', CTRL)).toBe('\x00')
  })

  it('puts ESC before a character with Alt, after Ctrl when both are armed', () => {
    expect(applyModifiers('b', ALT)).toBe('\x1bb')
    expect(applyModifiers('.', ALT)).toBe('\x1b.')
    expect(applyModifiers('x', BOTH)).toBe('\x1b\x18')
  })

  it('sends arrows, Home and End with xterm modifier parameters', () => {
    expect(applyModifiers('\x1b[D', CTRL)).toBe('\x1b[1;5D')
    expect(applyModifiers('\x1b[C', ALT)).toBe('\x1b[1;3C')
    expect(applyModifiers('\x1b[A', BOTH)).toBe('\x1b[1;7A')
    // Application cursor mode (SS3) from a hardware keyboard.
    expect(applyModifiers('\x1bOB', CTRL)).toBe('\x1b[1;5B')
    expect(applyModifiers('\x1b[H', CTRL)).toBe('\x1b[1;5H')
    expect(applyModifiers('\x1b[F', ALT)).toBe('\x1b[1;3F')
  })

  it('sends PgUp and PgDn with the modifier parameter', () => {
    expect(applyModifiers('\x1b[5~', CTRL)).toBe('\x1b[5;5~')
    expect(applyModifiers('\x1b[6~', ALT)).toBe('\x1b[6;3~')
  })

  it('leaves a paste or a committed word alone (null), so the modifier stays armed', () => {
    expect(applyModifiers('ls -la', CTRL)).toBeNull()
    expect(applyModifiers('xin chào', ALT)).toBeNull()
  })
})

describe('stickyModifierTransform', () => {
  function sticky(initial: StickyModifiers) {
    let mods = initial
    const transform = stickyModifierTransform(() => mods, () => { mods = { ctrl: false, alt: false } })
    return { transform, armed: () => mods }
  }

  it('sends a key-bar arrow with an armed Ctrl, then releases Ctrl', () => {
    const { transform, armed } = sticky(CTRL)
    expect(transform('\x1b[D')).toBe('\x1b[1;5D')
    expect(armed()).toEqual({ ctrl: false, alt: false })
    expect(transform('\x1b[D')).toBe('\x1b[D')
  })

  it('keeps the modifier armed across a paste, for the next key', () => {
    const { transform, armed } = sticky(ALT)
    expect(transform('two words')).toBe('two words')
    expect(armed()).toEqual(ALT)
    expect(transform('f')).toBe('\x1bf')
    expect(armed()).toEqual({ ctrl: false, alt: false })
  })
})
