/**
 * Alt+← / Alt+→ — the Windows and Linux back/forward keys. macOS keeps
 * ⌥← / ⌥→ for moving by word, and text fields (the terminal included,
 * xterm types into a textarea) keep them everywhere.
 */
import { afterEach, describe, expect, it, mock } from 'bun:test'
import { cleanup, render } from '@testing-library/react'

const backMock = mock(() => {})
const forwardMock = mock(() => {})
let os = 'windows'

mock.module('@tanstack/react-router', () => ({
  useRouter: () => ({ history: { back: backMock, forward: forwardMock } }),
}))
mock.module('@/hooks/use-platform', () => ({
  getPlatform: () => ({ isTauri: true, os }),
}))

const { useHistoryBackForwardShortcuts } = await import('@/hooks/useHistoryBackForwardShortcuts')

afterEach(() => {
  cleanup()
  backMock.mockClear()
  forwardMock.mockClear()
  document.body.innerHTML = ''
})

function Harness() {
  useHistoryBackForwardShortcuts()
  return null
}

function altArrow(key: 'ArrowLeft' | 'ArrowRight', target: EventTarget = document.body): KeyboardEvent {
  const e = new KeyboardEvent('keydown', { key, altKey: true, bubbles: true, cancelable: true })
  target.dispatchEvent(e)
  return e
}

describe('Alt+arrow history keys', () => {
  for (const platform of ['windows', 'linux']) {
    it(`steps back and forward on ${platform}`, () => {
      os = platform
      render(<Harness />)
      expect(altArrow('ArrowLeft').defaultPrevented).toBe(true)
      expect(backMock).toHaveBeenCalledTimes(1)
      expect(altArrow('ArrowRight').defaultPrevented).toBe(true)
      expect(forwardMock).toHaveBeenCalledTimes(1)
    })
  }

  it('leaves ⌥← alone on macOS', () => {
    os = 'macos'
    render(<Harness />)
    expect(altArrow('ArrowLeft').defaultPrevented).toBe(false)
    expect(backMock).not.toHaveBeenCalled()
  })

  it('leaves word movement alone in text fields and the terminal', () => {
    os = 'windows'
    render(<Harness />)
    const terminal = document.createElement('div')
    terminal.className = 'xterm'
    const helper = document.createElement('textarea')
    terminal.append(helper)
    document.body.append(terminal)

    expect(altArrow('ArrowLeft', helper).defaultPrevented).toBe(false)
    expect(backMock).not.toHaveBeenCalled()
  })
})
