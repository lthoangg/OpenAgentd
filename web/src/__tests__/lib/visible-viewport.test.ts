/**
 * Floating panels measure against the part of the screen the user can see:
 * on iOS the soft keyboard covers the bottom without shrinking innerHeight.
 */
import { afterEach, describe, expect, it, mock } from 'bun:test'

mock.module('lucide-react', () => new Proxy({}, { get: () => () => null }))

import { getVisibleViewport } from '@/lib/visible-viewport'
import { listPlacement } from '@/components/settings/AgentForm/ModelCombobox'

const realVV = Object.getOwnPropertyDescriptor(window, 'visualViewport')

function setVisualViewport(value: { height: number; offsetTop: number } | undefined) {
  Object.defineProperty(window, 'visualViewport', { value, configurable: true, writable: true })
}

afterEach(() => {
  if (realVV) Object.defineProperty(window, 'visualViewport', realVV)
})

function rect(top: number, bottom: number): DOMRect {
  return { top, bottom, left: 0, right: 300, width: 300, height: bottom - top, x: 0, y: top, toJSON: () => ({}) } as DOMRect
}

describe('getVisibleViewport', () => {
  it('is the layout viewport when there is no visual viewport', () => {
    setVisualViewport(undefined)
    expect(getVisibleViewport()).toEqual({ top: 0, bottom: window.innerHeight, height: window.innerHeight })
  })

  it('ends at the top of the keyboard', () => {
    setVisualViewport({ height: 400, offsetTop: 0 })
    expect(getVisibleViewport()).toEqual({ top: 0, bottom: 400, height: 400 })
  })
})

describe('ModelCombobox listPlacement', () => {
  it('opens below when the list fits above the keyboard', () => {
    expect(listPlacement(rect(100, 140), { top: 0, bottom: 600, height: 600 })).toEqual({ above: false, maxHeight: 256 })
  })

  it('flips above when the keyboard leaves no room below', () => {
    const placement = listPlacement(rect(300, 340), { top: 0, bottom: 380, height: 380 })
    expect(placement.above).toBe(true)
    expect(placement.maxHeight).toBe(256)
  })

  it('caps the height to the room on the chosen side', () => {
    expect(listPlacement(rect(150, 190), { top: 0, bottom: 300, height: 300 })).toEqual({ above: true, maxHeight: 138 })
  })
})
