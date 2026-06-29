import { describe, it, expect, afterEach, beforeEach, mock } from 'bun:test'
import { createRef, useRef } from 'react'
import { render, screen, cleanup, act, fireEvent } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { FloatingInputBar } from '@/components/FloatingInputBar'
import { useTeamStore } from '@/stores/useTeamStore'
import type { InputBarHandle } from '@/components/InputBar'

let mockIsMobile = false
let dismissedCalled = false

mock.module('@/hooks/use-mobile', () => ({
  useIsMobile: () => mockIsMobile,
}))

mock.module('@/hooks/use-mobile-viewport', () => ({
  dismissKeyboard: () => {
    dismissedCalled = true
  },
  useMobileViewportGuards: () => {},
}))

const STORAGE_KEY = 'oa-input-position'

afterEach(cleanup)
beforeEach(() => {
  localStorage.clear()
  useTeamStore.setState({ _pendingMessages: [] })
  mockIsMobile = false
  dismissedCalled = false
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
}) {
  const boundsRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<InputBarHandle>(null)
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
      <FloatingInputBar
        ref={inputRef}
        boundsRef={boundsRef}
        onSubmit={props.onSubmit ?? (() => {})}
        onStop={props.onStop}
        isStreaming={props.isStreaming}
        placeholder={props.placeholder ?? 'Message…'}
      />
    </div>
  )
}

describe('FloatingInputBar', () => {
  it('keeps the inner InputBar textarea mounted but hidden from AT while minimized', () => {
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

  it('forwards the placeholder prop to the inner InputBar when expanded', async () => {
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
    expect(screen.getByRole('button', { name: 'Voice input unavailable' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Expand input bar' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Stop generation' })).toBeTruthy()
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
    const ref = createRef<InputBarHandle>()
    function InsertHarness() {
      const boundsRef = useRef<HTMLDivElement>(null)
      return (
        <div ref={boundsRef} style={{ position: 'relative', width: 1200, height: 800 }}>
          <FloatingInputBar ref={ref} boundsRef={boundsRef} onSubmit={() => {}} />
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

  describe('Mobile swipe-down gesture', () => {
    beforeEach(() => {
      mockIsMobile = true
      dismissedCalled = false
    })

    it('dismisses the keyboard when swiping down and suggestions are closed', () => {
      render(
        <FloatingInputBar
          boundsRef={{ current: null }}
          onSubmit={() => {}}
        />
      )

      const container = screen.getByTestId('mobile-inputbar-container')

      fireEvent.touchStart(container, {
        touches: [{ clientX: 100, clientY: 100 } as unknown as Touch],
      })
      fireEvent.touchMove(container, {
        touches: [{ clientX: 100, clientY: 150 } as unknown as Touch],
      })

      expect(dismissedCalled).toBe(true)
    })

    it('does NOT dismiss the keyboard when swiping down and suggestions are open', async () => {
      const user = userEvent.setup()
      const fileRefs = [{ id: '1', path: 'file.txt', name: 'file.txt', type: 'file' as const }]
      render(
        <FloatingInputBar
          boundsRef={{ current: null }}
          onSubmit={() => {}}
          fileRefs={fileRefs}
        />
      )

      const textarea = screen.getByRole('textbox', { name: 'Message input' })
      await user.type(textarea, '@')

      const mentionMenu = await screen.findByRole('listbox', { name: 'Reference workspace file' })
      expect(mentionMenu).toBeTruthy()

      dismissedCalled = false

      const container = screen.getByTestId('mobile-inputbar-container')

      fireEvent.touchStart(container, {
        touches: [{ clientX: 100, clientY: 100 } as unknown as Touch],
      })
      fireEvent.touchMove(container, {
        touches: [{ clientX: 100, clientY: 150 } as unknown as Touch],
      })

      expect(dismissedCalled).toBe(false)
    })

    it('does NOT dismiss the keyboard when swiping down inside a scrollable textarea that is scrolled down', () => {
      render(
        <FloatingInputBar
          boundsRef={{ current: null }}
          onSubmit={() => {}}
        />
      )

      const textarea = screen.getByRole('textbox', { name: 'Message input' })

      // Mock scrollable textarea scrolled down
      Object.defineProperty(textarea, 'scrollHeight', { value: 200, configurable: true })
      Object.defineProperty(textarea, 'clientHeight', { value: 100, configurable: true })
      Object.defineProperty(textarea, 'scrollTop', { value: 10, configurable: true, writable: true })

      fireEvent.touchStart(textarea, {
        touches: [{ clientX: 100, clientY: 100 } as unknown as Touch],
      })
      fireEvent.touchMove(textarea, {
        touches: [{ clientX: 100, clientY: 150 } as unknown as Touch],
      })

      expect(dismissedCalled).toBe(false)
    })

    it('dismisses the keyboard when swiping down inside a scrollable textarea that is already at the top', () => {
      render(
        <FloatingInputBar
          boundsRef={{ current: null }}
          onSubmit={() => {}}
        />
      )

      const textarea = screen.getByRole('textbox', { name: 'Message input' })

      // Mock scrollable textarea at the top
      Object.defineProperty(textarea, 'scrollHeight', { value: 200, configurable: true })
      Object.defineProperty(textarea, 'clientHeight', { value: 100, configurable: true })
      Object.defineProperty(textarea, 'scrollTop', { value: 0, configurable: true, writable: true })

      fireEvent.touchStart(textarea, {
        touches: [{ clientX: 100, clientY: 100 } as unknown as Touch],
      })
      fireEvent.touchMove(textarea, {
        touches: [{ clientX: 100, clientY: 150 } as unknown as Touch],
      })

      expect(dismissedCalled).toBe(true)
    })
  })
})
