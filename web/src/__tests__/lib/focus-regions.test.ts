/**
 * F6 areas: the cycle follows the fixed order whatever the DOM order, skips
 * hidden and inert areas, enters each at the right element, and comes back
 * to where focus was.
 */
import { afterEach, describe, expect, it } from 'bun:test'
import { cycleRegion, enterRegion, rememberRegionFocus, visibleRegions } from '@/lib/focus-regions'

afterEach(() => {
  document.body.innerHTML = ''
})

/** Areas in a scrambled DOM order, as the shell renders them. */
function layout() {
  document.body.innerHTML = `
    <footer data-focus-region="status"><button id="health">Connected</button></footer>
    <div data-focus-region="dock"><button id="tab-a">a.ts</button><button id="tab-git" aria-current="true">Git</button></div>
    <nav data-focus-region="sidebar"><button id="row-1">One</button><button id="row-2" aria-current="page">Two</button></nav>
    <div data-focus-region="transcript" data-region-self id="transcript"><button id="copy">Copy</button></div>
    <div data-focus-region="composer"><button id="queued">Remove</button><textarea id="input" data-region-entry></textarea></div>
  `
}
const id = () => (document.activeElement as HTMLElement | null)?.id

describe('F6 areas', () => {
  it('orders the areas sidebar, transcript, composer, Review panel, status bar', () => {
    layout()
    expect(visibleRegions().map((el) => el.getAttribute('data-focus-region'))).toEqual(['sidebar', 'transcript', 'composer', 'dock', 'status'])
  })

  it('enters each area at its current item, its marked entry, or itself', () => {
    layout()
    expect(cycleRegion(1)?.id).toBe('row-2')
    expect(cycleRegion(1)?.id).toBe('transcript')
    expect(document.getElementById('transcript')?.getAttribute('tabindex')).toBe('-1')
    expect(cycleRegion(1)?.id).toBe('input')
    expect(cycleRegion(1)?.id).toBe('tab-git')
    expect(cycleRegion(1)?.id).toBe('health')
    // Around again.
    expect(cycleRegion(1)?.id).toBe('row-2')
    expect(cycleRegion(-1)?.id).toBe('health')
  })

  it('starts from the first area, or the last going back, when focus is outside them', () => {
    layout()
    expect(cycleRegion(-1)?.id).toBe('health')
    ;(document.activeElement as HTMLElement).blur()
    expect(cycleRegion(1)?.id).toBe('row-2')
  })

  it('returns to the element focused last in an area', () => {
    layout()
    const copy = document.getElementById('copy')!
    copy.focus()
    rememberRegionFocus(copy)
    cycleRegion(1)
    expect(id()).toBe('input')
    cycleRegion(-1)
    expect(id()).toBe('copy')
  })

  it('skips hidden and inert areas', () => {
    layout()
    document.querySelector<HTMLElement>('[data-focus-region="sidebar"]')!.setAttribute('inert', '')
    document.querySelector<HTMLElement>('[data-focus-region="dock"]')!.style.display = 'none'
    expect(visibleRegions().map((el) => el.getAttribute('data-focus-region'))).toEqual(['transcript', 'composer', 'status'])
  })

  it('takes the Review panel\'s panes in layout order, whatever their DOM order', () => {
    document.body.innerHTML = `
      <div data-focus-region="dock" data-focus-order="1"><button id="right">b.ts</button></div>
      <div data-focus-region="composer"><textarea id="input"></textarea></div>
      <div data-focus-region="dock" data-focus-order="0"><button id="left">a.ts</button></div>
    `
    expect(visibleRegions().map((el) => el.querySelector('*')?.id)).toEqual(['input', 'left', 'right'])
    expect(cycleRegion(1)?.id).toBe('input')
    expect(cycleRegion(1)?.id).toBe('left')
    expect(cycleRegion(1)?.id).toBe('right')
  })

  it('falls back to the first focusable control', () => {
    document.body.innerHTML = '<div data-focus-region="status" id="bar"><button id="first" disabled>x</button><button id="second">y</button></div>'
    expect(enterRegion(document.getElementById('bar')!).id).toBe('second')
  })
})
