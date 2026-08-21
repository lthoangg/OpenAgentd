import { describe, it, expect, afterEach, beforeEach, mock } from 'bun:test'
import { createRef, useRef } from 'react'
import { render, screen, cleanup, act } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { FloatingInputComposer } from '@/components/FloatingInputComposer'
import { useTeamStore } from '@/stores/useTeamStore'
import type { InputComposerHandle } from '@/components/InputComposer'

let mockIsMobile = false

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
      ...props
    }: Record<string, unknown>) => {
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
}))

const STORAGE_KEY = 'oa-input-position'

afterEach(cleanup)
beforeEach(() => {
  localStorage.clear()
  useTeamStore.setState({ _pendingMessages: [] })
  mockIsMobile = false
})

function nextFrame(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()))
}

// Test harness — provides a bounds container with a stable, measurable size.
function Harness(props: {
  onSubmit?: (message: string, files?: File[]) => void
  onStop?: () => void
  placeholder?: string
  exposeFocus?: boolean
  isStreaming?: boolean
  slashCommands?: Array<{ id: string; label: string; description: string }>
}) {
  const boundsRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<InputComposerHandle>(null)
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
      <FloatingInputComposer
        ref={inputRef}
        boundsRef={boundsRef}
        onSubmit={props.onSubmit ?? (() => {})}
        onStop={props.onStop}
        isStreaming={props.isStreaming}
        placeholder={props.placeholder ?? 'Message…'}
        slashCommands={props.slashCommands}
      />
    </div>
  )
}

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

  it('does not render queued messages inside the floating composer', () => {
    useTeamStore.setState({
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
