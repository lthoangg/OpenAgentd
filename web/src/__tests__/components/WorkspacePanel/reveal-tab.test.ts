/**
 * A tab is brought into view by its own strip. ``scrollIntoView`` scrolls
 * every ancestor too: on a phone the closed Review panel is parked beside
 * the screen, and showing its open tab slid the whole app sideways.
 */
import { afterEach, describe, expect, it } from 'bun:test'

import { revealTab } from '@/components/WorkspacePanel/reveal-tab'

function box(el: HTMLElement, left: number, right: number) {
  el.getBoundingClientRect = () => ({ left, right, top: 0, bottom: 28, width: right - left, height: 28, x: left, y: 0, toJSON: () => ({}) })
}

function strip(tabLeft: number, tabRight: number) {
  const shell = document.createElement('div')
  const scroller = document.createElement('div')
  scroller.setAttribute('data-dock-tab-scroller', '')
  const tab = document.createElement('button')
  scroller.append(tab)
  shell.append(scroller)
  document.body.append(shell)
  box(scroller, 100, 300)
  box(tab, tabLeft, tabRight)
  scroller.scrollLeft = 50
  return { shell, scroller, tab }
}

afterEach(() => {
  document.body.replaceChildren()
  document.body.scrollLeft = 0
})

describe('revealTab', () => {
  it('scrolls the strip right until a tab past its end shows', () => {
    const { scroller, tab } = strip(280, 340)
    revealTab(tab)
    expect(scroller.scrollLeft).toBe(90)
  })

  it('scrolls the strip left until a tab before its start shows', () => {
    const { scroller, tab } = strip(70, 130)
    revealTab(tab)
    expect(scroller.scrollLeft).toBe(20)
  })

  it('leaves a tab that already shows where it is', () => {
    const { scroller, tab } = strip(120, 180)
    revealTab(tab)
    expect(scroller.scrollLeft).toBe(50)
  })

  it('moves nothing outside the strip', () => {
    const { shell, tab } = strip(280, 340)
    revealTab(tab)
    expect(shell.scrollLeft).toBe(0)
    expect(document.body.scrollLeft).toBe(0)
  })
})
