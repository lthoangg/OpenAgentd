import { afterEach, describe, expect, it } from 'bun:test'
import { focusQuietly } from '@/lib/focus/quiet'

afterEach(() => {
  document.body.innerHTML = ''
})

describe('focusQuietly', () => {
  it('focuses without the ring until the element blurs', () => {
    document.body.innerHTML = '<button id="a">a</button><button id="b">b</button>'
    const a = document.getElementById('a') as HTMLButtonElement
    const b = document.getElementById('b') as HTMLButtonElement

    focusQuietly(a)
    expect(document.activeElement).toBe(a)
    expect(a.hasAttribute('data-quiet-focus')).toBe(true)

    b.focus()
    expect(a.hasAttribute('data-quiet-focus')).toBe(false)
    expect(b.hasAttribute('data-quiet-focus')).toBe(false)
  })

  it('leaves no flag when the element cannot take focus', () => {
    document.body.innerHTML = '<button id="a" disabled>a</button>'
    const a = document.getElementById('a') as HTMLButtonElement
    focusQuietly(a)
    expect(a.hasAttribute('data-quiet-focus')).toBe(false)
  })

  it('keeps the flag when only the window loses focus', () => {
    document.body.innerHTML = '<button id="a">a</button><button id="b">b</button>'
    const a = document.getElementById('a') as HTMLButtonElement
    const b = document.getElementById('b') as HTMLButtonElement

    focusQuietly(a)
    // Switching apps fires blur while the button stays the active element.
    a.dispatchEvent(new FocusEvent('blur'))
    expect(document.activeElement).toBe(a)
    expect(a.hasAttribute('data-quiet-focus')).toBe(true)

    b.focus()
    expect(a.hasAttribute('data-quiet-focus')).toBe(false)
  })
})
