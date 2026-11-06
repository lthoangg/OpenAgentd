/**
 * The dock's tab strip in motion: a closed tab's right-hand neighbours slide
 * into the gap and a new tab rises in (FLIP, horizontal); nothing slides
 * while a tab is being dragged or right after one is dropped inside its
 * strip (the drag already moved the others); a lifted tab grows and casts
 * its shadow, then settles with a soft spring. happy-dom has no layout, so
 * tabs report a fake `offsetLeft` from their index and `animate` is recorded.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { act, cleanup, fireEvent, render } from '@testing-library/react'
import { DockTabBar } from '@/components/WorkspacePanel/DockTabBar'
import type { DockTab } from '@/components/WorkspacePanel/dock-tabs'

const TAB = 100
const calls: { id: string; keyframes: Keyframe[]; options: KeyframeAnimationOptions }[] = []
const proto = HTMLElement.prototype as unknown as Record<string, unknown>
const saved = {
  offsetLeft: Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetLeft'),
  offsetParent: Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetParent'),
  animate: proto.animate,
}

beforeEach(() => {
  calls.length = 0
  Object.defineProperty(HTMLElement.prototype, 'offsetLeft', {
    configurable: true,
    get(this: HTMLElement) {
      const id = this.getAttribute('data-dock-tab')
      if (!id) return 0
      return Array.from(this.parentElement!.querySelectorAll('[data-dock-tab]')).indexOf(this) * TAB
    },
  })
  Object.defineProperty(HTMLElement.prototype, 'offsetParent', {
    configurable: true,
    get(this: HTMLElement) {
      return this.parentElement
    },
  })
  proto.animate = function (this: HTMLElement, keyframes: Keyframe[], options: KeyframeAnimationOptions) {
    calls.push({ id: this.getAttribute('data-dock-tab') ?? '', keyframes, options })
    return { cancel() {}, finished: Promise.resolve() }
  }
})

afterEach(() => {
  cleanup()
  if (saved.offsetLeft) Object.defineProperty(HTMLElement.prototype, 'offsetLeft', saved.offsetLeft)
  if (saved.offsetParent) Object.defineProperty(HTMLElement.prototype, 'offsetParent', saved.offsetParent)
  proto.animate = saved.animate
})

const tab = (id: string): DockTab => ({ id, type: 'file', title: id, file: { name: id, path: id } } as unknown as DockTab)
const TABS = ['a', 'b', 'c', 'd'].map(tab)

function Strip({ tabs, onMove = () => {} }: { tabs: DockTab[]; onMove?: (id: string, to: number) => void }) {
  return (
    <DockTabBar
      tabs={tabs}
      activeTabId="a"
      workspace="/repo"
      terminalMetas={[]}
      mobile={false}
      os="linux"
      registerTabRef={() => {}}
      onActivate={() => {}}
      onClose={() => {}}
      onMove={onMove}
      maximized={null}
      onToggleMaximized={() => {}}
    />
  )
}

const slides = () => calls.filter((call) => call.keyframes.some((frame) => String(frame.transform ?? '').startsWith('translateX')))
const tabEl = (container: HTMLElement, id: string) => container.querySelector<HTMLElement>(`[data-dock-tab="${id}"]`)!

describe('DockTabBar tab open and close', () => {
  it('slides the neighbours to the right of a closed tab into the gap, at base', () => {
    const { rerender } = render(<Strip tabs={TABS} />)
    rerender(<Strip tabs={TABS.filter((t) => t.id !== 'b')} />)

    const moved = Object.fromEntries(slides().map((call) => [call.id, call.keyframes[0].transform]))
    expect(moved).toEqual({ c: `translateX(${TAB}px)`, d: `translateX(${TAB}px)` })
    expect(slides()[0].options.duration).toBe(240)
    expect(slides()[0].keyframes[1]).toEqual({ transform: 'none' })
  })

  it('rises a new tab in at fast, from 2px below', () => {
    const { rerender } = render(<Strip tabs={TABS} />)
    rerender(<Strip tabs={[...TABS, tab('e')]} />)

    expect(calls).toHaveLength(1)
    expect(calls[0].id).toBe('e')
    expect(calls[0].keyframes).toEqual([{ opacity: 0, transform: 'translateY(2px)' }, { opacity: 1, transform: 'none' }])
    expect(calls[0].options.duration).toBe(150)
  })

  it('does not animate the first render or a change that keeps the tabs in place', () => {
    const { rerender } = render(<Strip tabs={TABS} />)
    rerender(<Strip tabs={TABS.map((t) => ({ ...t, title: `${t.title}!` }) as DockTab)} />)
    expect(calls).toEqual([])
  })
})

describe('DockTabBar tab drag', () => {
  const press = (el: HTMLElement) => fireEvent.pointerDown(el, { pointerId: 1, button: 0, pointerType: 'mouse', clientX: 10, clientY: 10 })
  const move = (el: HTMLElement, x: number) => fireEvent.pointerMove(el, { pointerId: 1, pointerType: 'mouse', clientX: x, clientY: 10 })

  it('does not slide neighbours while a tab is held, nor for the reorder its drop commits', () => {
    const moves: [string, number][] = []
    const { container, rerender } = render(<Strip tabs={TABS} onMove={(id, to) => moves.push([id, to])} />)
    const a = tabEl(container, 'a')
    press(a)
    act(() => { move(a, 40) })
    expect(a.hasAttribute('data-dragging')).toBe(true)

    // The tab list changes under the drag (e.g. a tab closes): still no slide.
    rerender(<Strip tabs={TABS.filter((t) => t.id !== 'd')} onMove={(id, to) => moves.push([id, to])} />)
    expect(slides()).toEqual([])
  })

  it('lifts the held tab at fast and settles it from where it was let go with a soft spring', () => {
    const { container, rerender } = render(<Strip tabs={TABS} />)
    const a = tabEl(container, 'a')
    press(a)
    act(() => { move(a, 40) })

    const lift = calls.filter((call) => call.keyframes.some((frame) => frame.transform === 'scale(1.02)'))
    expect(lift).toHaveLength(1)
    expect(lift[0].id).toBe('a')
    expect(lift[0].options.duration).toBe(150)
    expect(lift[0].options.composite).toBe('add')
    const shadow = calls.find((call) => call.keyframes.some((frame) => frame.boxShadow === 'var(--shadow-depth)'))
    expect(shadow?.options.duration).toBe(150)

    calls.length = 0
    act(() => { fireEvent.pointerUp(a, { pointerId: 1, pointerType: 'mouse', clientX: 40, clientY: 10 }) })
    rerender(<Strip tabs={TABS} />)

    const settle = calls.find((call) => call.keyframes.some((frame) => frame.transform === 'none' && frame.boxShadow === 'none'))
    expect(settle?.id).toBe('a')
    expect(settle?.options.duration).toBe(240)
    expect(String(settle?.options.easing)).toBe('cubic-bezier(0.34, 1.2, 0.64, 1)')
  })

  it('a drop that reorders the strip slides nobody: the drag already moved them', () => {
    const boxes = (el: HTMLElement) => {
      const at = Array.from(el.parentElement!.querySelectorAll('[data-dock-tab]')).indexOf(el) * TAB
      return { left: at, right: at + TAB, top: 0, bottom: 30, width: TAB, height: 30, x: at, y: 0 } as DOMRect
    }
    const original = proto.getBoundingClientRect
    proto.getBoundingClientRect = function (this: HTMLElement) {
      return this.hasAttribute('data-dock-tab') ? boxes(this) : (original as () => DOMRect).call(this)
    }
    try {
      const moves: [string, number][] = []
      const onMove = (id: string, to: number) => moves.push([id, to])
      const { container, rerender } = render(<Strip tabs={TABS} onMove={onMove} />)
      const a = tabEl(container, 'a')
      press(a)
      act(() => { move(a, 260) })
      act(() => { fireEvent.pointerUp(a, { pointerId: 1, pointerType: 'mouse', clientX: 260, clientY: 10 }) })
      expect(moves).toEqual([['a', 2]])

      rerender(<Strip tabs={[TABS[1], TABS[2], TABS[0], TABS[3]]} onMove={onMove} />)
      // Only the dropped tab moves, settling from where it was let go.
      expect(slides().map((call) => call.id)).toEqual(['a'])
      expect(slides()[0].keyframes[0].boxShadow).toBe('var(--shadow-depth)')
    } finally {
      if (original) proto.getBoundingClientRect = original
      else delete proto.getBoundingClientRect
    }
  })

  it('a reorder from the keyboard or menu (no drag) does slide', () => {
    const { rerender } = render(<Strip tabs={TABS} />)
    rerender(<Strip tabs={[TABS[1], TABS[0], TABS[2], TABS[3]]} />)
    expect(slides().map((call) => call.id).sort()).toEqual(['a', 'b'])
  })
})
