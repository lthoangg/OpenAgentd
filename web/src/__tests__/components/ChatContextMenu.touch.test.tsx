/**
 * The transcript's action menu outside the desktop app: a plain browser opens
 * the app menu on right-click, and a touch long press opens the same items as
 * a bottom sheet. Text the user is selecting keeps the system's own menu.
 */
import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import { readFileSync } from 'node:fs'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'

import { useFakeTimers } from '../fake-timers'

const platform = { isTauri: false, os: 'macos', isMacOverlay: false }
mock.module('@/hooks/use-platform', () => ({
  usePlatform: () => platform,
  getPlatform: () => platform,
}))

// The shell's commands: a menu or sheet of ours never calls one.
const shellCalls: unknown[] = []
mock.module('@tauri-apps/api/core', () => ({
  invoke: (command: string, args: unknown) => {
    shellCalls.push([command, args])
    return Promise.resolve(null)
  },
}))

const haptics: string[] = []
mock.module('@/lib/haptics', () => ({
  softHapticFeedback: () => haptics.push('soft'),
  mediumHapticFeedback: () => haptics.push('medium'),
  selectionHapticFeedback: () => haptics.push('selection'),
  outcomeHapticFeedback: () => haptics.push('outcome'),
  haptic: () => haptics.push('haptic'),
}))

const { useChatMenu } = await import('@/components/ChatContextMenu')
const { CodeBlock } = await import('@/components/CodeBlock')
const { LONG_PRESS_MS } = await import('@/hooks/use-long-press')
// The sheet loads on first use; have it cached so a test only waits a tick.
await import('@/components/ChatMenuSheet')

const realMatchMedia = window.matchMedia
function setCoarse(coarse: boolean) {
  window.matchMedia = ((query: string) => ({
    matches: coarse && query === '(pointer: coarse)',
    media: query,
    addEventListener() {},
    removeEventListener() {},
    addListener() {},
    removeListener() {},
    onchange: null,
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia
}

// The hold is stepped, not waited for: deterministic under the parallel run.
let timers: ReturnType<typeof useFakeTimers>
beforeEach(() => {
  platform.isTauri = false
  platform.os = 'macos'
  shellCalls.length = 0
  haptics.length = 0
  setCoarse(false)
  timers = useFakeTimers()
})
afterEach(() => {
  cleanup()
  timers.restore()
  window.matchMedia = realMatchMedia
  window.getSelection()?.removeAllRanges()
})

const picked: string[] = []

function Message({ label = 'Actions for message', children }: { label?: string; children?: React.ReactNode }) {
  const chatMenu = useChatMenu(label, () => [
    { label: 'Copy', run: () => picked.push('Copy') },
    { label: 'Edit', run: () => picked.push('Edit') },
  ])
  return (
    <div data-testid="message" onContextMenu={chatMenu.onContextMenu} onKeyDown={chatMenu.onKeyDown}>
      <p>Fix the build</p>
      {children}
      {chatMenu.menu}
    </div>
  )
}

function Link() {
  const chatMenu = useChatMenu('Actions for link', () => [{ label: 'Open link', run: () => picked.push('Open link') }])
  return (
    <a href="https://example.com" onContextMenu={chatMenu.onContextMenu} onKeyDown={chatMenu.onKeyDown}>
      the docs
      {chatMenu.menu}
    </a>
  )
}

const touch = (extra: Record<string, unknown> = {}) => ({ pointerType: 'touch', pointerId: 1, clientX: 40, clientY: 40, ...extra })
// Hold, then let the lazily loaded sheet mount (setImmediate is not faked).
const hold = async () => {
  await act(async () => { timers.tick(LONG_PRESS_MS + 60) })
  await act(async () => { await new Promise((resolve) => setImmediate(resolve)) })
}
const menuItems = () => screen.queryAllByRole('menuitem').map((item) => item.textContent)

describe('right-click in a plain browser', () => {
  it('opens the app menu and keeps the native one away', () => {
    render(<Message />)
    expect(fireEvent.contextMenu(screen.getByText('Fix the build'))).toBe(false)
    expect(screen.getByRole('menu', { name: 'Actions for message' })).toBeTruthy()
    expect(menuItems()).toEqual(['Copy', 'Edit'])
  })

  it('runs an item and closes', async () => {
    picked.length = 0
    render(<Message />)
    fireEvent.contextMenu(screen.getByText('Fix the build'))
    await act(async () => { screen.getByRole('menuitem', { name: 'Edit' }).click() })
    expect(picked).toEqual(['Edit'])
    expect(screen.queryByRole('menu')).toBeNull()
  })

  it('leaves selected text to the browser menu, which has Copy', () => {
    render(<Message />)
    const text = screen.getByText('Fix the build')
    const range = document.createRange()
    range.selectNodeContents(text)
    window.getSelection()!.addRange(range)
    expect(fireEvent.contextMenu(text)).toBe(true)
    expect(screen.queryByRole('menu')).toBeNull()
  })

  it('gives the innermost surface the event', () => {
    render(<Message><Link /></Message>)
    fireEvent.contextMenu(screen.getByRole('link', { name: 'the docs' }))
    expect(screen.getAllByRole('menu')).toHaveLength(1)
    expect(menuItems()).toEqual(['Open link'])
  })
})

describe('long press in the iOS app', () => {
  it('opens the app’s own sheet, not the system action sheet, and runs the chosen item', async () => {
    setCoarse(true)
    platform.isTauri = true
    platform.os = 'ios'
    picked.length = 0
    render(<Message />)
    fireEvent.pointerDown(screen.getByText('Fix the build'), touch())

    await hold()

    const sheet = screen.getByRole('dialog', { name: 'Actions for message' })
    expect(sheet.getAttribute('data-bottom-sheet')).toBe('')
    expect(shellCalls).toEqual([])
    expect(haptics).toEqual(['medium'])
    await act(async () => { screen.getByRole('button', { name: 'Edit' }).click() })
    expect(picked).toEqual(['Edit'])
  })
})

describe('long press on touch', () => {
  it('opens the items as a bottom sheet with a medium haptic, not a floating menu', async () => {
    setCoarse(true)
    picked.length = 0
    render(<Message />)
    fireEvent.pointerDown(screen.getByText('Fix the build'), touch())
    expect(screen.queryByRole('dialog')).toBeNull()

    await hold()
    const sheet = screen.getByRole('dialog', { name: 'Actions for message' })
    expect(sheet.getAttribute('data-bottom-sheet')).toBe('')
    expect(screen.queryByRole('menu')).toBeNull()
    expect(haptics).toEqual(['medium'])

    const buttons = Array.from(sheet.querySelectorAll('button')).map((b) => b.textContent)
    expect(buttons).toEqual(['Copy', 'Edit'])
    await act(async () => { screen.getByRole('button', { name: 'Edit' }).click() })
    expect(picked).toEqual(['Edit'])
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('does nothing for a tap, a drag past the tolerance, or a press taken over by a scroll', async () => {
    setCoarse(true)
    render(<Message />)
    const target = screen.getByText('Fix the build')

    fireEvent.pointerDown(target, touch())
    fireEvent.pointerUp(target, touch())
    await hold()
    expect(screen.queryByRole('dialog')).toBeNull()

    fireEvent.pointerDown(target, touch())
    fireEvent.pointerMove(target, touch({ clientY: 40 + 11 }))
    await hold()
    expect(screen.queryByRole('dialog')).toBeNull()

    fireEvent.pointerDown(target, touch())
    fireEvent.pointerCancel(target, touch())
    await hold()
    expect(screen.queryByRole('dialog')).toBeNull()

    fireEvent.pointerDown(target, touch())
    fireEvent.scroll(document.body)
    await hold()
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(haptics).toEqual([])
  })

  it('forgives a small wobble of the finger', async () => {
    setCoarse(true)
    render(<Message />)
    const target = screen.getByText('Fix the build')
    fireEvent.pointerDown(target, touch())
    fireEvent.pointerMove(target, touch({ clientX: 40 + 5, clientY: 40 + 5 }))
    await hold()
    expect(screen.getByRole('dialog', { name: 'Actions for message' })).toBeTruthy()
  })

  it('ignores a mouse press: desktop keeps right-click', async () => {
    setCoarse(true)
    render(<Message />)
    const target = screen.getByText('Fix the build')
    fireEvent.pointerDown(target, touch({ pointerType: 'mouse' }))
    expect(screen.getByTestId('message').hasAttribute('data-pressing')).toBe(false)
    await hold()
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  describe('the press lifts the surface while it is held', () => {
    const pressing = () => screen.getByTestId('message').hasAttribute('data-pressing')

    it('marks the surface from pointerdown and clears it once the menu opens', async () => {
      setCoarse(true)
      render(<Message />)
      fireEvent.pointerDown(screen.getByText('Fix the build'), touch())
      expect(pressing()).toBe(true)
      await hold()
      expect(screen.getByRole('dialog', { name: 'Actions for message' })).toBeTruthy()
      expect(pressing()).toBe(false)
    })

    it('clears on lift, move-out, cancel and scroll', () => {
      setCoarse(true)
      render(<Message />)
      const target = screen.getByText('Fix the build')
      for (const end of [
        () => fireEvent.pointerUp(target, touch()),
        () => fireEvent.pointerMove(target, touch({ clientY: 40 + 11 })),
        () => fireEvent.pointerCancel(target, touch()),
        () => fireEvent.scroll(document.body),
      ]) {
        fireEvent.pointerDown(target, touch())
        expect(pressing()).toBe(true)
        end()
        expect(pressing()).toBe(false)
      }
    })

    it('keeps it through a small wobble, and drops it when a second finger lands', () => {
      setCoarse(true)
      render(<Message />)
      const target = screen.getByText('Fix the build')
      fireEvent.pointerDown(target, touch())
      fireEvent.pointerMove(target, touch({ clientX: 40 + 5, clientY: 40 + 5 }))
      expect(pressing()).toBe(true)
      fireEvent.pointerDown(target, touch({ pointerId: 2 }))
      expect(pressing()).toBe(false)
    })

    it('marks only the innermost surface a held link belongs to', () => {
      setCoarse(true)
      render(<Message><Link /></Message>)
      fireEvent.pointerDown(screen.getByRole('link', { name: 'the docs' }), touch())
      expect(screen.getByRole('link', { name: 'the docs' }).hasAttribute('data-pressing')).toBe(true)
      expect(pressing()).toBe(false)
    })

    it('is drawn by index.css: scale 0.98 at the instant token, via the scale property', () => {
      const css = readFileSync(new URL('../../index.css', import.meta.url), 'utf8')
      const rule = css.match(/\[data-pressing\]\s*\{([^}]*)\}/)?.[1] ?? ''
      expect(rule).toContain('scale: 0.98')
      expect(rule).toContain('transition: scale var(--motion-instant) var(--ease-out)')
      expect(rule).not.toContain('transform')
    })
  })

  it('does not open over text the user is selecting', async () => {
    setCoarse(true)
    render(<Message />)
    const text = screen.getByText('Fix the build')
    fireEvent.pointerDown(text, touch())
    const range = document.createRange()
    range.selectNodeContents(text)
    window.getSelection()!.addRange(range)
    await hold()
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(haptics).toEqual([])
  })

  it('opens the innermost surface only: a held link gets the link sheet, not the message sheet too', async () => {
    setCoarse(true)
    render(<Message><Link /></Message>)
    fireEvent.pointerDown(screen.getByRole('link', { name: 'the docs' }), touch())
    await hold()
    expect(screen.getAllByRole('dialog')).toHaveLength(1)
    expect(screen.getByRole('dialog', { name: 'Actions for link' })).toBeTruthy()
    expect(haptics).toEqual(['medium'])
  })

  it('leaves a button inside the surface to its own press', async () => {
    setCoarse(true)
    render(
      <Message>
        <button type="button">Retry</button>
      </Message>,
    )
    fireEvent.pointerDown(screen.getByRole('button', { name: 'Retry' }), touch())
    await hold()
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('takes the context-menu event a touch long press can raise (Android) as the sheet', async () => {
    setCoarse(true)
    render(<Message />)
    expect(fireEvent.contextMenu(screen.getByText('Fix the build'))).toBe(false)
    await act(async () => { await new Promise((resolve) => setImmediate(resolve)) })
    expect(screen.getByRole('dialog', { name: 'Actions for message' })).toBeTruthy()
    expect(screen.queryByRole('menu')).toBeNull()
    // The hold timer that follows must not open a second sheet or tick again.
    fireEvent.pointerDown(screen.getByText('Fix the build'), touch())
    await hold()
    expect(screen.getAllByRole('dialog')).toHaveLength(1)
    expect(haptics).toEqual(['medium'])
  })

  it('listens on the document once for all surfaces, and stops with the last one', () => {
    setCoarse(true)
    const calls: string[] = []
    const add = document.addEventListener
    const remove = document.removeEventListener
    document.addEventListener = ((type: string, ...rest: unknown[]) => {
      if (type === 'pointerdown') calls.push('add')
      return (add as (...args: unknown[]) => void).call(document, type, ...rest)
    }) as typeof document.addEventListener
    document.removeEventListener = ((type: string, ...rest: unknown[]) => {
      if (type === 'pointerdown') calls.push('remove')
      return (remove as (...args: unknown[]) => void).call(document, type, ...rest)
    }) as typeof document.removeEventListener
    try {
      const first = render(<Message />)
      const second = render(<Message />)
      expect(calls).toEqual(['add'])
      first.unmount()
      expect(calls).toEqual(['add'])
      second.unmount()
      expect(calls).toEqual(['add', 'remove'])
    } finally {
      document.addEventListener = add
      document.removeEventListener = remove
    }
  })
})

describe('a code block', () => {
  it('leaves a long press to the system (text selection), and keeps its Copy button for taps', async () => {
    setCoarse(true)
    render(<CodeBlock language="ts" rawText="const a = 1">const a = 1</CodeBlock>)
    fireEvent.pointerDown(screen.getByText('const a = 1'), touch())
    await hold()
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(screen.getByRole('button', { name: 'Copy code' })).toBeTruthy()
  })
})
