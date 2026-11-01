import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'

import { PanelResizeHandle, ResizableAside, settledWidthBesidePanels } from '@/components/ResizableAside'

// rAF is async in browsers: queue frames and flush them explicitly.
const frames: FrameRequestCallback[] = []
const realRaf = globalThis.requestAnimationFrame

beforeEach(() => {
  frames.length = 0
  globalThis.requestAnimationFrame = ((callback: FrameRequestCallback) => frames.push(callback)) as typeof requestAnimationFrame
})

afterEach(() => {
  cleanup()
  globalThis.requestAnimationFrame = realRaf
})

function moveTo(clientX: number) {
  act(() => {
    window.dispatchEvent(new MouseEvent('pointermove', { clientX }))
    while (frames.length > 0) frames.shift()?.(0)
  })
}

describe('ResizableAside', () => {
  it('drags without re-rendering the panel content, then commits once', () => {
    let contentRenders = 0
    function Content() {
      contentRenders += 1
      return <p>content</p>
    }
    const onCommit = mock(() => {})
    const motionCalls: Array<{ width: number; isResizing: boolean }> = []
    const getMotion = (live: { width: number; isResizing: boolean }) => {
      motionCalls.push(live)
      return { animate: { width: live.width }, transition: { duration: 0 } }
    }

    render(
      <ResizableAside
        aria-label="Panel"
        resize={{ width: 300, min: 200, max: 500, edge: 'right', onCommit, label: 'Resize panel' }}
        getMotion={getMotion}
      >
        <PanelResizeHandle edge="right" />
        <Content />
      </ResizableAside>,
    )
    const separator = screen.getByRole('separator', { name: 'Resize panel' })
    expect(separator.getAttribute('aria-valuenow')).toBe('300')
    const settled = contentRenders

    fireEvent.pointerDown(separator, { button: 0, clientX: 100, pointerType: 'mouse' })
    moveTo(150)
    moveTo(180)

    expect(separator.getAttribute('aria-valuenow')).toBe('380')
    expect(motionCalls.at(-1)).toEqual({ width: 380, isResizing: true })
    expect(contentRenders).toBe(settled)
    expect(onCommit).not.toHaveBeenCalled()

    act(() => { window.dispatchEvent(new MouseEvent('pointerup')) })
    expect(onCommit).toHaveBeenCalledTimes(1)
    expect(onCommit).toHaveBeenCalledWith(380)
    expect(contentRenders).toBe(settled)
  })

  it('renders no handle outside a ResizableAside', () => {
    render(<PanelResizeHandle edge="left" />)
    expect(screen.queryByRole('separator')).toBeNull()
  })

  // Desktop panels show and hide as a straight cut. Through an animation the
  // width waited for a frame, and a throttled frame loop (a hidden window)
  // left the panel at 0 px; as a style it is there on the first paint.
  it('sets the width as a plain style with instantWidth, without waiting for a frame', () => {
    const { rerender } = render(
      <ResizableAside
        aria-label="Panel"
        resize={{ width: 300, min: 200, max: 500, edge: 'right', onCommit: () => {}, label: 'Resize panel' }}
        getMotion={(live) => ({ animate: { width: live.width }, transition: { duration: 0.01 }, instantWidth: true })}
      >
        <p>content</p>
      </ResizableAside>,
    )
    const aside = screen.getByRole('complementary', { name: 'Panel' })
    expect(aside.style.width).toBe('300px')
    expect(aside.getAttribute('data-panel-target-width')).toBe('300')
    expect(frames).toHaveLength(0)

    rerender(
      <ResizableAside
        aria-label="Panel"
        resize={{ width: 300, min: 200, max: 500, edge: 'right', onCommit: () => {}, label: 'Resize panel' }}
        getMotion={() => ({ animate: { width: 0 }, transition: { duration: 0.01 }, instantWidth: true })}
      >
        <p>content</p>
      </ResizableAside>,
    )
    expect(aside.style.width).toBe('0px')
  })

  // Closing tweens the aside's width to 0. Content that tracked that width
  // reflowed every frame (a long plan: ~10 ms a frame); pinned to the target
  // width it is only clipped by the shrinking aside.
  it('pins the content to the width the motion asks for so open and close tweens only clip it', () => {
    render(
      <ResizableAside
        aria-label="Panel"
        pinContentWidth
        resize={{ width: 300, min: 200, max: 500, edge: 'right', onCommit: () => {}, label: 'Resize panel' }}
        getMotion={(live) => ({ animate: { width: 0 }, transition: { duration: 0 }, pinWidth: live.width })}
      >
        <p>content</p>
      </ResizableAside>,
    )
    expect((screen.getByText('content').parentElement as HTMLElement).style.width).toBe('300px')
  })

  // A resize tween with the content pinned at the target clipped its far
  // side (growing) or left a blank strip there (shrinking) until it ended.
  it('lets the content fill the aside through any other width change', () => {
    render(
      <ResizableAside
        aria-label="Panel"
        pinContentWidth
        resize={{ width: 300, min: 200, max: 500, edge: 'right', onCommit: () => {}, label: 'Resize panel' }}
        getMotion={(live) => ({ animate: { width: live.width }, transition: { duration: 0 } })}
      >
        <PanelResizeHandle edge="right" />
        <p>content</p>
      </ResizableAside>,
    )
    const content = screen.getByText('content').parentElement as HTMLElement
    expect(content.style.width).toBe('100%')
    fireEvent.pointerDown(screen.getByRole('separator'), { button: 0, clientX: 100, pointerType: 'mouse' })
    moveTo(150)
    expect(content.style.width).toBe('100%')
  })
})

describe('settledWidthBesidePanels', () => {
  // The sidebar mid-tween: rendered at ``rendered`` px on its way to ``target``.
  function row(rendered: number, target: number) {
    render(
      <div>
        <ResizableAside
          aria-label="Sidebar"
          style={{ borderRight: '1px solid' }}
          resize={{ width: 264, min: 200, max: 500, edge: 'right', onCommit: () => {}, label: 'Resize sidebar' }}
          getMotion={() => ({ animate: { width: target }, transition: { duration: 0 } })}
        >
          <p>sidebar</p>
        </ResizableAside>
        <div data-testid="center" />
      </div>,
    )
    const sidebar = screen.getByRole('complementary', { name: 'Sidebar' })
    sidebar.getBoundingClientRect = () => ({ width: rendered }) as DOMRect
    const center = screen.getByTestId('center')
    center.getBoundingClientRect = () => ({ width: 1000 - rendered }) as DOMRect
    return center
  }

  it('measures the center for where a closing sidebar ends, down to its border', () => {
    expect(settledWidthBesidePanels(row(120, 0))).toBe(999)
  })

  it('measures the center for where an opening sidebar ends', () => {
    expect(settledWidthBesidePanels(row(40, 264))).toBe(736)
  })

  it('is the rendered width once the sidebar has settled', () => {
    expect(settledWidthBesidePanels(row(264, 264))).toBe(736)
    cleanup()
    expect(settledWidthBesidePanels(row(1, 0))).toBe(999)
  })
})
