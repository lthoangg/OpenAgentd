/**
 * usePreventStrayFileDrop — global guard against the browser default of
 * *navigating to* a file that gets dropped outside a real drop zone.
 */
import { describe, it, expect, afterEach } from 'bun:test'
import { render, cleanup } from '@testing-library/react'
import { usePreventStrayFileDrop } from '@/hooks/usePreventStrayFileDrop'

afterEach(() => {
  cleanup()
  document.body.innerHTML = ''
})

function Harness() {
  usePreventStrayFileDrop()
  return null
}

function dispatchDrag(
  type: 'dragover' | 'drop',
  target: EventTarget,
  types: string[] = ['Files'],
): Event & { dataTransfer: { types: string[]; dropEffect: string } } {
  const e = new Event(type, { bubbles: true, cancelable: true })
  const dataTransfer = { types, dropEffect: 'copy' }
  Object.defineProperty(e, 'dataTransfer', { value: dataTransfer })
  target.dispatchEvent(e)
  return e as Event & { dataTransfer: typeof dataTransfer }
}

function elementOutsideZone(): HTMLElement {
  const el = document.createElement('div')
  document.body.appendChild(el)
  return el
}

function elementInsideZone(): HTMLElement {
  const zone = document.createElement('div')
  zone.setAttribute('data-file-drop-zone', '')
  const child = document.createElement('div')
  zone.appendChild(child)
  document.body.appendChild(zone)
  return child
}

describe('usePreventStrayFileDrop', () => {
  it('swallows a file drop outside any drop zone', () => {
    render(<Harness />)

    const e = dispatchDrag('drop', elementOutsideZone())

    expect(e.defaultPrevented).toBe(true)
  })

  it('marks a stray dragover as not-allowed instead of a copy target', () => {
    render(<Harness />)

    const e = dispatchDrag('dragover', elementOutsideZone())

    expect(e.defaultPrevented).toBe(true)
    expect(e.dataTransfer.dropEffect).toBe('none')
  })

  it('leaves drops inside a drop zone to that zone', () => {
    render(<Harness />)

    const e = dispatchDrag('drop', elementInsideZone())

    expect(e.defaultPrevented).toBe(false)
  })

  it('ignores non-file drags so text drag-and-drop still works', () => {
    render(<Harness />)

    const e = dispatchDrag('drop', elementOutsideZone(), ['text/plain'])

    expect(e.defaultPrevented).toBe(false)
  })

  it('removes the listeners on unmount', () => {
    const { unmount } = render(<Harness />)
    unmount()

    const e = dispatchDrag('drop', elementOutsideZone())

    expect(e.defaultPrevented).toBe(false)
  })
})
