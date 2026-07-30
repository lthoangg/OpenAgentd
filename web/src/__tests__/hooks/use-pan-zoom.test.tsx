import { afterEach, describe, expect, it } from 'bun:test'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { useRef } from 'react'
import { usePanZoom } from '@/hooks/use-pan-zoom'

afterEach(cleanup)

function PanZoomHarness() {
  const targetRef = useRef<HTMLDivElement>(null)
  const panZoom = usePanZoom(targetRef)

  return (
    <>
      <div ref={targetRef} data-testid="pan-zoom-target" {...panZoom.bind} />
      <output aria-label="Zoom level">{panZoom.zoomPercent}%</output>
      <button type="button" onClick={panZoom.zoomIn}>Zoom in</button>
      <button type="button" onClick={panZoom.zoomOut}>Zoom out</button>
      <button type="button" onClick={panZoom.reset}>Reset zoom</button>
    </>
  )
}

describe('usePanZoom', () => {
  it('zooms between 50% and 400% and resets the transformed target to fit', () => {
    render(<PanZoomHarness />)
    const target = screen.getByTestId('pan-zoom-target')

    expect(screen.getByRole('status', { name: 'Zoom level' }).textContent).toBe('100%')
    fireEvent.click(screen.getByRole('button', { name: 'Zoom in' }))
    expect(screen.getByRole('status', { name: 'Zoom level' }).textContent).toBe('125%')
    expect(target.style.transform).toContain('scale(1.25)')

    for (let i = 0; i < 20; i++) fireEvent.click(screen.getByRole('button', { name: 'Zoom out' }))
    expect(screen.getByRole('status', { name: 'Zoom level' }).textContent).toBe('50%')

    fireEvent.click(screen.getByRole('button', { name: 'Reset zoom' }))
    expect(screen.getByRole('status', { name: 'Zoom level' }).textContent).toBe('100%')
    expect(target.style.transform).toContain('scale(1)')
  })

  it('zooms around wheel input and toggles on double click without re-rendering the target', () => {
    render(<PanZoomHarness />)
    const target = screen.getByTestId('pan-zoom-target')

    fireEvent.wheel(target, { deltaY: -100, clientX: 100, clientY: 100 })
    expect(screen.getByRole('status', { name: 'Zoom level' }).textContent).toBe('125%')

    fireEvent.doubleClick(target)
    expect(screen.getByRole('status', { name: 'Zoom level' }).textContent).toBe('100%')
    fireEvent.doubleClick(target)
    expect(screen.getByRole('status', { name: 'Zoom level' }).textContent).toBe('200%')
  })

  it('uses zoom-in, grab, and grabbing cursors through the desktop interaction cycle', () => {
    render(<PanZoomHarness />)
    const target = screen.getByTestId('pan-zoom-target')
    Object.defineProperties(target, {
      clientWidth: { configurable: true, value: 200 },
      clientHeight: { configurable: true, value: 200 },
    })

    expect(target.style.cursor).toBe('zoom-in')
    fireEvent.keyDown(target, { key: '+' })
    expect(screen.getByRole('status', { name: 'Zoom level' }).textContent).toBe('125%')
    expect(target.style.cursor).toBe('grab')
    fireEvent.doubleClick(target)
    fireEvent.doubleClick(target)
    fireEvent.mouseDown(target, { button: 0, clientX: 0, clientY: 0 })
    expect(target.style.cursor).toBe('grabbing')
    fireEvent.mouseMove(target, { clientX: 40, clientY: 30 })
    expect(target.style.cursor).toBe('grabbing')
    fireEvent.mouseUp(target)

    expect(target.style.transform).toContain('translate3d(40px, 30px, 0) scale(2)')
    expect(target.style.cursor).toBe('grab')
    fireEvent.click(screen.getByRole('button', { name: 'Reset zoom' }))
    expect(target.style.cursor).toBe('zoom-in')
  })

  it('pinch-zooms and toggles zoom on a mobile double tap', () => {
    render(<PanZoomHarness />)
    const target = screen.getByTestId('pan-zoom-target')

    fireEvent.touchStart(target, { touches: [{ clientX: 0, clientY: 0 }, { clientX: 50, clientY: 0 }] })
    fireEvent.touchMove(target, { touches: [{ clientX: 0, clientY: 0 }, { clientX: 100, clientY: 0 }] })
    fireEvent.touchEnd(target)
    expect(screen.getByRole('status', { name: 'Zoom level' }).textContent).toBe('200%')

    fireEvent.click(screen.getByRole('button', { name: 'Reset zoom' }))
    fireEvent.touchStart(target, { touches: [{ clientX: 20, clientY: 20 }] })
    fireEvent.touchEnd(target)
    fireEvent.touchStart(target, { touches: [{ clientX: 20, clientY: 20 }] })
    fireEvent.touchEnd(target)
    expect(screen.getByRole('status', { name: 'Zoom level' }).textContent).toBe('200%')
  })
})
