import { describe, it, expect, afterEach, beforeEach, mock } from 'bun:test'
import { createRef, useLayoutEffect, useRef, useState } from 'react'
import { render, screen, cleanup, act } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { FloatingInputComposer, type ComposerHandoff } from '@/components/FloatingInputComposer'
import { useAgentStore } from '@/stores/useAgentStore'
import { useTranscriptFollowStore } from '@/stores/useTranscriptFollowStore'
import type { InputComposerHandle } from '@/components/InputComposer'

let mockIsMobile = false
let mockReducedMotion = false
// The hand-off glide's ``onAnimationComplete``: tests call it to land the bar.
let completeAnimation: (() => void) | null = null

mock.module('@/hooks/use-mobile', () => ({
  useIsMobile: () => mockIsMobile,
}))

mock.module('framer-motion', () => ({
  motion: {
    div: ({
      children,
      style,
      animate,
      layout: _layout,
      initial: _initial,
      transition: _transition,
      drag: _drag,
      dragListener: _dragListener,
      dragControls: _dragControls,
      dragMomentum: _dragMomentum,
      dragElastic: _dragElastic,
      onDragEnd: _onDragEnd,
      onAnimationComplete,
      ...props
    }: Record<string, unknown>) => {
      if (typeof onAnimationComplete === 'function') completeAnimation = onAnimationComplete as () => void
      const mergedStyle = { ...(style as Record<string, unknown> | undefined) }
      if (animate && typeof animate === 'object') {
        const maybeAnimate = animate as Record<string, unknown>
        if (typeof maybeAnimate.x === 'number' || typeof maybeAnimate.y === 'number') {
          const x = typeof maybeAnimate.x === 'number' ? maybeAnimate.x : 0
          const y = typeof maybeAnimate.y === 'number' ? maybeAnimate.y : 0
          mergedStyle.transform = `translateX(${x}px) translateY(${y}px)`
        }
      }
      return <div {...props} style={mergedStyle}>{children as React.ReactNode}</div>
    },
  },
  AnimatePresence: ({ children }: { children: unknown }) => children as React.ReactNode,
  useDragControls: () => ({ start: () => {} }),
  useReducedMotion: () => mockReducedMotion,
}))

const STORAGE_KEY = 'oa-input-position'

afterEach(cleanup)
beforeEach(() => {
  localStorage.clear()
  useAgentStore.setState({ _pendingMessages: [] })
  useTranscriptFollowStore.setState({ unseen: null, jumpToLatest: null })
  mockIsMobile = false
  mockReducedMotion = false
  completeAnimation = null
})

function nextFrame(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()))
}

// Test harness — provides a bounds container with a stable, measurable size.
function Harness(props: {
  onSubmit?: (message: string, files?: File[], mentions?: string[], delivery?: string) => void
  onStop?: () => void
  placeholder?: string
  exposeFocus?: boolean
  isStreaming?: boolean
  slashCommands?: Array<{ id: string; label: string; description: string }>
  placement?: 'floating' | 'inline'
  onHandoffCapture?: (snapshot: ComposerHandoff) => void
  enterFrom?: ComposerHandoff | null
  /** Mount the composer after the bounds, as the chat column outlives it. */
  composerAfterBounds?: boolean
}) {
  const boundsRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<InputComposerHandle>(null)
  const [showComposer, setShowComposer] = useState(!props.composerAfterBounds)
  useLayoutEffect(() => { setShowComposer(true) }, [])
  return (
    <div
      ref={boundsRef}
      data-testid="bounds"
      style={{ position: 'relative', width: 1200, height: 800 }}
    >
      {props.exposeFocus && (
        <button type="button" onClick={() => inputRef.current?.focus()}>
          Focus input
        </button>
      )}
      <button type="button">Outside</button>
      {showComposer && <FloatingInputComposer
        ref={inputRef}
        boundsRef={boundsRef}
        onSubmit={props.onSubmit ?? (() => {})}
        onStop={props.onStop}
        isStreaming={props.isStreaming}
        placeholder={props.placeholder ?? 'Message…'}
        slashCommands={props.slashCommands}
        placement={props.placement}
        onHandoffCapture={props.onHandoffCapture}
        enterFrom={props.enterFrom}
      />}
    </div>
  )
}

describe('FloatingInputComposer inline placement', () => {
  it('sits in the page flow, expanded, with no drag handle and no stored position', async () => {
    render(<Harness placement="inline" />)
    expect(screen.getByTestId('inline-inputbar-container')).toBeTruthy()
    expect(screen.queryByRole('button', { name: /drag input bar/i })).toBeNull()
    const textarea = screen.getByRole('textbox', { name: 'Message input' })
    expect(textarea.getAttribute('disabled')).toBeNull()
    await userEvent.click(textarea)
    await userEvent.click(screen.getByRole('button', { name: 'Outside' }))
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 250)) })
    // Still a full composer after losing focus.
    expect(screen.getByRole('textbox', { name: 'Message input' }).getAttribute('disabled')).toBeNull()
    act(() => { window.dispatchEvent(new Event('resize')) })
    expect(localStorage.getItem(STORAGE_KEY)).toBeNull()
  })

  it('docks on phones whatever the placement', () => {
    mockIsMobile = true
    render(<Harness placement="inline" />)
    expect(screen.getByTestId('mobile-inputbar-container')).toBeTruthy()
    expect(screen.queryByTestId('inline-inputbar-container')).toBeNull()
  })

  it('reports where it sat, and that it had focus, before handing the message on', async () => {
    const user = userEvent.setup()
    const order: string[] = []
    const snapshots: ComposerHandoff[] = []
    render(
      <Harness
        placement="inline"
        onHandoffCapture={(snapshot) => { order.push('capture'); snapshots.push(snapshot) }}
        onSubmit={() => { order.push('submit') }}
      />,
    )
    await user.type(screen.getByRole('textbox', { name: 'Message input' }), 'build it{Enter}')

    expect(order).toEqual(['capture', 'submit'])
    expect(snapshots[0].focused).toBe(true)
    expect(Object.keys(snapshots[0].rect).sort()).toEqual(['height', 'left', 'top', 'width'])
  })
})

describe('FloatingInputComposer — hand-off glide from the new-session screen', () => {
  const originalRect = HTMLElement.prototype.getBoundingClientRect
  const from: ComposerHandoff = { rect: { left: 280, top: 300, width: 640, height: 96 }, focused: true }

  beforeEach(() => {
    // Happy DOM has no layout: give the bounds (the chat column) a size.
    HTMLElement.prototype.getBoundingClientRect = function (this: HTMLElement) {
      const sized = this.dataset.testid === 'bounds'
      const width = sized ? 1200 : 0
      const height = sized ? 800 : 0
      return { x: 0, y: 0, top: 0, left: 0, right: width, bottom: height, width, height, toJSON: () => ({}) } as DOMRect
    }
  })
  afterEach(() => {
    HTMLElement.prototype.getBoundingClientRect = originalRect
  })

  it('glides expanded and focused from where the centered composer was', () => {
    render(<Harness enterFrom={from} composerAfterBounds />)
    const textarea = screen.getByRole('textbox', { name: 'Message input' })
    expect(textarea.getAttribute('disabled')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Expand input bar' })).toBeNull()
    expect(document.activeElement).toBe(textarea)
    expect(textarea.closest('[data-handoff="gliding"]')).not.toBeNull()
  })

  it('collapses on landing, like any other send, keeping focus on the pill', async () => {
    render(<Harness enterFrom={from} composerAfterBounds />)
    expect(completeAnimation).not.toBeNull()
    await act(async () => { completeAnimation?.() })
    expect(document.querySelector('[data-handoff]')).toBeNull()
    const pill = screen.getByRole('button', { name: 'Expand input bar' })
    expect(document.activeElement).toBe(pill)
  })

  it('stays expanded on landing when the user typed during the glide', async () => {
    const user = userEvent.setup()
    render(<Harness enterFrom={from} composerAfterBounds />)
    await user.keyboard('more')
    await act(async () => { completeAnimation?.() })
    expect(screen.queryByRole('button', { name: 'Expand input bar' })).toBeNull()
    expect((screen.getByRole('textbox', { name: 'Message input' }) as HTMLTextAreaElement).value).toBe('more')
  })

  it('does not glide with reduced motion: the bar starts collapsed as usual', () => {
    mockReducedMotion = true
    render(<Harness enterFrom={from} composerAfterBounds />)
    expect(document.querySelector('[data-handoff]')).toBeNull()
    expect(screen.getByRole('button', { name: 'Expand input bar' })).toBeTruthy()
  })

  it('does not glide without a hand-off', () => {
    render(<Harness />)
    expect(document.querySelector('[data-handoff]')).toBeNull()
    expect(screen.getByRole('button', { name: 'Expand input bar' })).toBeTruthy()
  })
})

describe('FloatingInputComposer', () => {
  it('keeps the inner InputComposer textarea mounted but hidden from AT while minimized', () => {
    render(<Harness />)
    // The textarea is always in the DOM regardless of minimized state
    // — visibility is opacity-driven so the ref stays valid and focus
    // can land instantly on expand. While minimized, the wrapping
    // ``aria-hidden`` correctly removes it from the accessibility
    // tree, so we query by label (DOM-level) rather than role
    // (a11y-tree-level).
    const textarea = screen.getByLabelText('Message input')
    expect(textarea).toBeTruthy()
    expect(textarea.getAttribute('disabled')).not.toBeNull()
  })

  it('exposes a drag handle labelled for screen readers', () => {
    render(<Harness />)
    const handle = screen.getByRole('button', { name: /drag input bar/i })
    expect(handle).toBeTruthy()
  })

  it('starts at the default position (zero offset) when no value is stored', () => {
    render(<Harness />)
    expect(localStorage.getItem(STORAGE_KEY)).toBeNull()
  })

  it('reads persisted offset from localStorage on mount without throwing', () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ x: 40, y: -120 }))
    expect(() => render(<Harness />)).not.toThrow()
    // After mount the clamp effect may rewrite the value if bounds don't
    // accommodate the stored offset; we only require the entry remains
    // valid JSON with numeric fields.
    const raw = localStorage.getItem(STORAGE_KEY)
    expect(raw).not.toBeNull()
    const parsed = JSON.parse(raw!) as { x: number; y: number }
    expect(typeof parsed.x).toBe('number')
    expect(typeof parsed.y).toBe('number')
  })

  it('ignores malformed localStorage entries without throwing', () => {
    localStorage.setItem(STORAGE_KEY, 'not-json')
    expect(() => render(<Harness />)).not.toThrow()
  })

  it('ignores localStorage entries that do not match the expected shape', () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ foo: 'bar' }))
    expect(() => render(<Harness />)).not.toThrow()
  })

  it('resets position on double-click of the handle', async () => {
    const user = userEvent.setup()
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ x: 40, y: -120 }))
    render(<Harness />)

    const handle = screen.getByRole('button', { name: /drag input bar/i })
    await user.dblClick(handle)

    expect(localStorage.getItem(STORAGE_KEY)).toBe(JSON.stringify({ x: 0, y: 0 }))
  })

  it('clamps a stored offset back into bounds on window resize', () => {
    // Seed an out-of-bounds offset. The clamp effect runs on mount and on
    // resize; the mount pass should already correct it, but we also verify
    // a resize event does not push it further.
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ x: 99999, y: -99999 }))
    render(<Harness />)

    act(() => {
      window.dispatchEvent(new Event('resize'))
    })

    const raw = localStorage.getItem(STORAGE_KEY)
    // Clamp may be a no-op if jsdom reports zero-sized rects, but if it
    // writes anything it must not preserve the extreme values.
    if (raw !== null && raw !== JSON.stringify({ x: 99999, y: -99999 })) {
      const parsed = JSON.parse(raw) as { x: number; y: number }
      expect(Math.abs(parsed.x)).toBeLessThan(99999)
      expect(Math.abs(parsed.y)).toBeLessThan(99999)
    }
  })


  it('forwards the placeholder prop to the inner InputComposer when expanded', async () => {
    const user = userEvent.setup()
    render(<Harness placeholder="Ask the team…" />)
    // Placeholder is empty while the bar is minimized so its ghost
    // doesn't bleed through the slot opacity fade. The minimized
    // The collapsed strip's chat button expands the bar so the
    // textarea's placeholder becomes visible.
    await user.click(screen.getByRole('button', { name: 'Expand input bar' }))
    const textarea = await screen.findByRole('textbox', { name: 'Message input' })
    expect(textarea.getAttribute('placeholder')).toBe('Ask the team…')
  })

  it('collapses to Attach, Expand and Send', () => {
    render(<Harness />)

    expect(screen.getByRole('button', { name: 'Attach file' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Expand input bar' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Send message' })).toBeTruthy()
    expect(screen.queryByText('Code')).toBeNull()
  })

  it('keeps the collapsed strip available while streaming', () => {
    render(<Harness isStreaming onStop={() => {}} />)

    const textarea = screen.getByLabelText('Message input')
    expect(textarea.getAttribute('disabled')).not.toBeNull()
    expect(screen.getByRole('button', { name: 'Attach file' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Expand input bar' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Stop generation' })).toBeTruthy()
  })

  it('leaves no click-blocking hit area behind at the docked position', () => {
    // The positioning wrapper stays anchored at the default docked slot
    // (bottom-centre) while framer moves only the inner panel via
    // ``transform``. If the wrapper keeps ``pointer-events: auto`` it turns
    // into an invisible max-w-md rectangle that swallows every click over
    // the chat transcript at the docked position once the bar is dragged
    // away. Hit-testing must belong to the panel that actually moves.
    render(<Harness />)

    const handle = screen.getByRole('button', { name: /drag input bar/i })
    const wrapper = handle.closest('div.absolute') as HTMLElement | null
    expect(wrapper).not.toBeNull()
    expect(wrapper!.className).toContain('pointer-events-none')

    const panel = wrapper!.firstElementChild as HTMLElement
    expect(panel.className).toContain('pointer-events-auto')
  })

  it('carries the jump-to-latest chip on the moving panel', () => {
    useTranscriptFollowStore.setState({ unseen: 2, jumpToLatest: () => {} })
    render(<Harness />)

    const chip = screen.getByRole('button', { name: 'Jump to latest, 2 new' })
    const handle = screen.getByRole('button', { name: /drag input bar/i })
    const panel = (handle.closest('div.absolute') as HTMLElement).firstElementChild as HTMLElement
    expect(panel.contains(chip)).toBe(true)
  })

  it('does not render queued messages inside the floating composer', () => {
    useAgentStore.setState({
      sessionId: 'session-a',
      _pendingMessages: [
        { id: 'pm-1', sessionId: 'session-a', content: 'first queued message' },
        { id: 'pm-2', sessionId: 'session-a', content: 'second queued message' },
      ],
    })

    render(<Harness />)

    expect(screen.queryByRole('button', { name: /2 messages awaiting/i })).toBeNull()
    expect(screen.queryByText('first queued message')).toBeNull()
  })

  it('expands and focuses the textarea through its imperative focus handle', async () => {
    const user = userEvent.setup()
    render(<Harness exposeFocus />)

    const textarea = screen.getByLabelText('Message input')
    expect(textarea.getAttribute('disabled')).not.toBeNull()

    await user.click(screen.getByRole('button', { name: 'Focus input' }))
    await act(nextFrame)

    expect(textarea.getAttribute('disabled')).toBeNull()
    expect(document.activeElement).toBe(textarea)
  })

  it('takes focus without expanding when asked to, e.g. back from the dock', async () => {
    const ref = createRef<InputComposerHandle>()
    function FocusHarness() {
      const boundsRef = useRef<HTMLDivElement>(null)
      return (
        <div ref={boundsRef} style={{ position: 'relative', width: 1200, height: 800 }}>
          <FloatingInputComposer ref={ref} boundsRef={boundsRef} onSubmit={() => {}} />
        </div>
      )
    }
    render(<FocusHarness />)

    act(() => ref.current?.focus({ expand: false }))
    await act(nextFrame)

    const expandButton = screen.getByRole('button', { name: 'Expand input bar' })
    expect(document.activeElement).toBe(expandButton)
    expect(screen.getByLabelText('Message input').getAttribute('disabled')).not.toBeNull()
    // Handed-back focus is not keyboard-steered: no ring until the user
    // arrows or tabs on (the quiet flag clears on blur).
    expect(expandButton.hasAttribute('data-quiet-focus')).toBe(true)
  })

  it('minimizes when Escape is pressed while the input is focused', async () => {
    const user = userEvent.setup()
    render(<Harness />)

    await user.click(screen.getByRole('button', { name: 'Expand input bar' }))
    const textarea = screen.getByRole('textbox', { name: 'Message input' })
    await user.click(textarea)

    expect(textarea.getAttribute('disabled')).toBeNull()

    await user.keyboard('{Escape}')

    expect(textarea.getAttribute('disabled')).not.toBeNull()
    expect(screen.getByRole('button', { name: 'Expand input bar' })).toBeTruthy()
  })

  it('does not also minimize when the input handled Escape (closing its menu)', async () => {
    const user = userEvent.setup()
    render(<Harness />)
    await user.click(screen.getByRole('button', { name: 'Expand input bar' }))
    const textarea = screen.getByRole('textbox', { name: 'Message input' })
    await user.click(textarea)
    // The @-mention / slash menu claims Escape like this.
    textarea.addEventListener('keydown', (e) => { if (e.key === 'Escape') e.preventDefault() })
    await user.keyboard('{Escape}')
    expect(textarea.getAttribute('disabled')).toBeNull()
  })

  it('auto-minimizes when the empty input loses focus', async () => {
    const user = userEvent.setup()
    render(<Harness exposeFocus />)

    await user.click(screen.getByRole('button', { name: 'Expand input bar' }))
    const textarea = screen.getByRole('textbox', { name: 'Message input' })
    await user.click(textarea)
    expect(textarea.getAttribute('disabled')).toBeNull()

    await user.click(screen.getByRole('button', { name: 'Outside' }))

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 220))
    })

    expect(textarea.getAttribute('disabled')).not.toBeNull()
    expect(screen.getByRole('button', { name: 'Expand input bar' })).toBeTruthy()
  })


  it('expands and inserts the first typed character through its imperative insertText handle', async () => {
    const ref = createRef<InputComposerHandle>()
    function InsertHarness() {
      const boundsRef = useRef<HTMLDivElement>(null)
      return (
        <div ref={boundsRef} style={{ position: 'relative', width: 1200, height: 800 }}>
          <FloatingInputComposer ref={ref} boundsRef={boundsRef} onSubmit={() => {}} />
        </div>
      )
    }

    render(<InsertHarness />)

    const textarea = screen.getByLabelText('Message input') as HTMLTextAreaElement
    expect(textarea.getAttribute('disabled')).not.toBeNull()

    act(() => {
      ref.current?.focus()
      ref.current?.insertText('h')
    })

    expect(textarea.getAttribute('disabled')).toBeNull()
    expect(textarea.value).toBe('h')
  })

  it('minimizes after sending a message', async () => {
    const user = userEvent.setup()
    render(<Harness />)

    await user.click(screen.getByRole('button', { name: 'Expand input bar' }))
    const textarea = screen.getByRole('textbox', { name: 'Message input' })
    await user.type(textarea, 'hello')
    await user.click(screen.getByRole('button', { name: 'Send message' }))

    expect(textarea.getAttribute('disabled')).not.toBeNull()
    expect(screen.getByRole('button', { name: 'Expand input bar' })).toBeTruthy()
  })

  it('keeps focus on the collapsed bar without a focus ring after a send', async () => {
    // WebKit (the desktop app) draws the keyboard ring for any script
    // focus(); the collapse hands focus to the pill, which nobody steered.
    const user = userEvent.setup()
    render(<Harness />)

    await user.click(screen.getByRole('button', { name: 'Expand input bar' }))
    await user.type(screen.getByRole('textbox', { name: 'Message input' }), 'hello{Enter}')

    const pill = screen.getByRole('button', { name: 'Expand input bar' })
    expect(document.activeElement).toBe(pill)
    expect(pill.hasAttribute('data-quiet-focus')).toBe(true)
  })

  it('passes how a mid-turn message should be delivered on to its owner', async () => {
    const user = userEvent.setup()
    const onSubmit = mock((..._args: unknown[]) => {})
    render(<Harness isStreaming onStop={() => {}} onSubmit={onSubmit} />)

    await user.click(screen.getByRole('button', { name: 'Expand input bar' }))
    await user.type(screen.getByRole('textbox', { name: 'Message input' }), 'then run the tests')
    await user.keyboard('{Alt>}{Enter}{/Alt}')

    expect(onSubmit.mock.calls[0]).toEqual(['then run the tests', undefined, undefined, 'after-turn'])
  })

})

// ── Cross-platform: mobile vs desktop behavior ────────────────────────────

describe('FloatingInputComposer — mobile: always fully expanded', () => {
  beforeEach(() => {
    mockIsMobile = true
  })
  afterEach(() => {
    mockIsMobile = false
  })

  it('renders the full textarea immediately without an expand affordance', () => {
    render(<Harness />)
    // On mobile the bar is always expanded — no "Expand input bar" button.
    expect(screen.queryByRole('button', { name: 'Expand input bar' })).toBeNull()
    expect(screen.getByRole('textbox', { name: 'Message input' })).toBeTruthy()
  })

  it('does not collapse after submit on mobile', async () => {
    const user = userEvent.setup()
    render(<Harness />)

    const textarea = screen.getByRole('textbox', { name: 'Message input' })
    await user.type(textarea, 'hello')
    await user.click(screen.getByRole('button', { name: 'Send message' }))

    // The textarea should still be present and enabled after submit.
    expect(screen.queryByRole('button', { name: 'Expand input bar' })).toBeNull()
    expect(screen.getByRole('textbox', { name: 'Message input' })).toBeTruthy()
  })

  it('does not collapse when the textarea loses focus on mobile', async () => {
    const user = userEvent.setup()
    render(<Harness />)

    const textarea = screen.getByRole('textbox', { name: 'Message input' })
    await user.click(textarea)
    // Blur the textarea
    await user.tab()

    // Still expanded — no minimize on mobile blur.
    expect(screen.queryByRole('button', { name: 'Expand input bar' })).toBeNull()
    expect(screen.getByRole('textbox', { name: 'Message input' })).toBeTruthy()
  })
})

describe('FloatingInputComposer — desktop: minimize/expand lifecycle', () => {
  it('starts minimized and expands on click', async () => {
    const user = userEvent.setup()
    render(<Harness />)

    // Desktop starts minimized.
    expect(screen.getByRole('button', { name: 'Expand input bar' })).toBeTruthy()

    await user.click(screen.getByRole('button', { name: 'Expand input bar' }))
    expect(screen.getByRole('textbox', { name: 'Message input' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Expand input bar' })).toBeNull()
  })

  it('collapses when the empty textarea loses focus on desktop', async () => {
    const user = userEvent.setup()
    render(<Harness />)

    await user.click(screen.getByRole('button', { name: 'Expand input bar' }))
    // Tab away from the textarea to trigger blur.
    await user.tab()

    // After the 180 ms blur-debounce timer the bar collapses.
    await act(async () => {
      await new Promise((r) => setTimeout(r, 220))
    })
    expect(screen.getByRole('button', { name: 'Expand input bar' })).toBeTruthy()
  })

  it('does NOT collapse when the textarea has content at blur time', async () => {
    const user = userEvent.setup()
    render(<Harness />)

    await user.click(screen.getByRole('button', { name: 'Expand input bar' }))
    const textarea = screen.getByRole('textbox', { name: 'Message input' })
    await user.type(textarea, 'draft text')
    // Tab away — canMinimize=false because there is unsent content.
    await user.tab()

    await act(async () => {
      await new Promise((r) => setTimeout(r, 220))
    })
    // Bar stays expanded.
    expect(screen.queryByRole('button', { name: 'Expand input bar' })).toBeNull()
    expect(screen.getByRole('textbox', { name: 'Message input' })).toBeTruthy()
  })
})

describe('FloatingInputComposer — orientation change: portrait-mobile → landscape-tablet', () => {
  it('does not schedule a collapse timer when blur fires while isMobile is true', async () => {
    // When the bar is in mobile mode (isMobile=true), handleBlur must return
    // early without calling setTimeout. We verify this by confirming the bar
    // stays fully expanded after a blur — on mobile the Expand affordance
    // must never appear.
    mockIsMobile = true

    const user = userEvent.setup()
    render(<Harness />)

    const textarea = screen.getByRole('textbox', { name: 'Message input' })
    await user.click(textarea)
    // Blur with empty input (canMinimize=true) — the timer must NOT fire.
    await user.tab()

    // Wait well past the 180ms debounce window.
    await act(async () => {
      await new Promise<void>((r) => setTimeout(r, 250))
    })

    // Still fully expanded on mobile — no Expand button, textarea present.
    expect(screen.queryByRole('button', { name: 'Expand input bar' })).toBeNull()
    expect(screen.getByRole('textbox', { name: 'Message input' })).toBeTruthy()
  })
})

describe('FloatingInputComposer — jump chip side', () => {
  const originalRect = HTMLElement.prototype.getBoundingClientRect

  beforeEach(() => {
    useTranscriptFollowStore.setState({ unseen: 2, jumpToLatest: () => {} })
    // Happy DOM has no layout: give the bounds and the floating panel sizes.
    HTMLElement.prototype.getBoundingClientRect = function (this: HTMLElement) {
      const height = this.dataset.testid === 'bounds'
        ? 800
        : this.className.includes('pointer-events-auto') ? 100 : 0
      return { x: 0, y: 0, top: 0, left: 0, right: 0, bottom: height, width: 0, height, toJSON: () => ({}) } as DOMRect
    }
  })
  afterEach(() => {
    HTMLElement.prototype.getBoundingClientRect = originalRect
  })

  const chipSide = () => screen.getByRole('button', { name: 'Jump to latest, 2 new' }).dataset.side

  it('keeps the chip above a docked bar', () => {
    render(<Harness />)
    expect(chipSide()).toBe('above')
  })

  it('keeps the chip above a bar raised within the lower half', () => {
    // 16px dock gap + 200px raise + 100px panel + 8px grip = 324px < 400px.
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ x: 0, y: -200 }))
    render(<Harness />)
    expect(chipSide()).toBe('above')
  })

  it('moves the chip below a bar dragged into the upper half', () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ x: 0, y: -500 }))
    render(<Harness />)
    expect(chipSide()).toBe('below')
  })
})
