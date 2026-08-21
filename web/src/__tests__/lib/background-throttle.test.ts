import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import {
  initBackgroundThrottle,
  isAppHidden,
  updateBackgroundThrottleState,
} from '@/lib/background-throttle'

describe('background-throttle', () => {
  let originalHidden: PropertyDescriptor | undefined
  let originalVisibilityState: PropertyDescriptor | undefined

  function setVisibility(hidden: boolean, state: 'visible' | 'hidden') {
    Object.defineProperty(document, 'hidden', { configurable: true, value: hidden })
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: state })
    Object.defineProperty(Document.prototype, 'hidden', { configurable: true, value: hidden })
    Object.defineProperty(Document.prototype, 'visibilityState', { configurable: true, value: state })
  }

  beforeEach(() => {
    originalHidden = Object.getOwnPropertyDescriptor(document, 'hidden')
      || Object.getOwnPropertyDescriptor(Document.prototype, 'hidden')
    originalVisibilityState = Object.getOwnPropertyDescriptor(document, 'visibilityState')
      || Object.getOwnPropertyDescriptor(Document.prototype, 'visibilityState')
    document.documentElement.removeAttribute('data-app-hidden')
    setVisibility(false, 'visible')
  })

  afterEach(() => {
    if (originalHidden) {
      Object.defineProperty(document, 'hidden', originalHidden)
      Object.defineProperty(Document.prototype, 'hidden', originalHidden)
    }
    if (originalVisibilityState) {
      Object.defineProperty(document, 'visibilityState', originalVisibilityState)
      Object.defineProperty(Document.prototype, 'visibilityState', originalVisibilityState)
    }
    document.documentElement.removeAttribute('data-app-hidden')
  })

  it('sets data-app-hidden when document is hidden', () => {
    setVisibility(true, 'hidden')

    updateBackgroundThrottleState()
    expect(document.documentElement.getAttribute('data-app-hidden')).toBe('true')
    expect(isAppHidden()).toBe(true)
  })

  it('removes data-app-hidden when document is visible', () => {
    document.documentElement.setAttribute('data-app-hidden', 'true')
    setVisibility(false, 'visible')

    updateBackgroundThrottleState()
    expect(document.documentElement.hasAttribute('data-app-hidden')).toBe(false)
    expect(isAppHidden()).toBe(false)
  })

  it('subscribes to visibilitychange and pagehide/pageshow events', () => {
    const cleanup = initBackgroundThrottle()

    // Simulate hiding
    setVisibility(true, 'hidden')
    document.dispatchEvent(new Event('visibilitychange'))
    expect(document.documentElement.getAttribute('data-app-hidden')).toBe('true')

    // Simulate showing
    setVisibility(false, 'visible')
    document.dispatchEvent(new Event('visibilitychange'))
    expect(document.documentElement.hasAttribute('data-app-hidden')).toBe(false)

    // Simulate pagehide
    window.dispatchEvent(new Event('pagehide'))
    expect(document.documentElement.getAttribute('data-app-hidden')).toBe('true')

    // Simulate pageshow
    setVisibility(false, 'visible')
    window.dispatchEvent(new Event('pageshow'))
    expect(document.documentElement.hasAttribute('data-app-hidden')).toBe(false)

    cleanup()
  })
})
