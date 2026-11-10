/**
 * The recovery code may be copied (tunnel-threats.md, "Recovery code"): the
 * code alone does not open the account. A copy is cleared, best effort,
 * two minutes later while the app is visible.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'

import { RecoveryStep } from '@/components/account/RecoveryStep'
import { cancelClipboardClear, CLIPBOARD_CLEAR_MS } from '@/lib/clipboard-clear'
import { useFakeTimers } from '../../fake-timers'

const CODE = 'AAAAA-BBBBB-CCCCC-DDDDD-EEEEE-FFFFF-GGGGG'
let writes: string[] = []
let failWrites = false
let visibility: DocumentVisibilityState = 'visible'
const realClipboard = Object.getOwnPropertyDescriptor(navigator, 'clipboard')
const realVisibility = Object.getOwnPropertyDescriptor(Document.prototype, 'visibilityState')

beforeEach(() => {
  writes = []
  failWrites = false
  visibility = 'visible'
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: {
      writeText: async (text: string) => {
        if (failWrites) throw new Error('NotAllowedError')
        writes.push(text)
      },
    },
  })
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => visibility })
})

afterEach(() => {
  cleanup()
  cancelClipboardClear()
  if (realClipboard) Object.defineProperty(navigator, 'clipboard', realClipboard)
  delete (document as unknown as Record<string, unknown>).visibilityState
  if (realVisibility) Object.defineProperty(Document.prototype, 'visibilityState', realVisibility)
})

function step() {
  return render(
    <RecoveryStep
      code={CODE}
      check={[2, 5]}
      busy={false}
      onCancel={() => {}}
      confirm={{ mutate: () => {}, error: null, isPending: false }}
    />,
  )
}

const flush = () => act(async () => { await Promise.resolve() })

describe('RecoveryStep', () => {
  it('advises how to keep the code, and lets it be selected', () => {
    step()
    expect(screen.getByText('Keep it in a password manager, take a screenshot, or write it down. It is shown only once.')).toBeTruthy()
    const code = screen.getByText('AAAAA BBBBB CCCCC DDDDD EEEEE').parentElement as HTMLElement
    expect(code.className).not.toContain('select-none')
    // Copy and the context menu are not blocked any more.
    const copy = new Event('copy', { bubbles: true, cancelable: true })
    code.dispatchEvent(copy)
    expect(copy.defaultPrevented).toBe(false)
  })

  it('copies the code as given, says so, and clears the clipboard once after 2 minutes', async () => {
    const timers = useFakeTimers()
    try {
      step()
      fireEvent.click(screen.getByRole('button', { name: 'Copy code' }))
      await flush()
      expect(writes).toEqual([CODE])
      expect(screen.getByText('Copied. The clipboard is cleared in 2 minutes.')).toBeTruthy()

      timers.tick(CLIPBOARD_CLEAR_MS - 1)
      await flush()
      expect(writes).toEqual([CODE])
      timers.tick(1)
      await flush()
      expect(writes).toEqual([CODE, ''])
      timers.tick(CLIPBOARD_CLEAR_MS * 2)
      await flush()
      expect(writes).toEqual([CODE, ''])
    } finally {
      timers.restore()
    }
  })

  it('waits until the app is visible again to clear', async () => {
    const timers = useFakeTimers()
    try {
      step()
      fireEvent.click(screen.getByRole('button', { name: 'Copy code' }))
      await flush()
      visibility = 'hidden'
      timers.tick(CLIPBOARD_CLEAR_MS)
      await flush()
      expect(writes).toEqual([CODE])

      visibility = 'visible'
      document.dispatchEvent(new Event('visibilitychange'))
      await flush()
      expect(writes).toEqual([CODE, ''])
      document.dispatchEvent(new Event('visibilitychange'))
      await flush()
      expect(writes).toEqual([CODE, ''])
    } finally {
      timers.restore()
    }
  })

  it('says what to do when copying fails', async () => {
    failWrites = true
    step()
    fireEvent.click(screen.getByRole('button', { name: 'Copy code' }))
    expect(await screen.findByText("Couldn't copy. Take a screenshot or write it down.")).toBeTruthy()
  })

  it('still clears after the step closes, and cleans up after itself', async () => {
    const timers = useFakeTimers()
    try {
      const view = step()
      fireEvent.click(screen.getByRole('button', { name: 'Copy code' }))
      await flush()
      // Confirmed within two minutes: the promise on screen still holds.
      view.unmount()
      timers.tick(CLIPBOARD_CLEAR_MS)
      await flush()
      expect(writes).toEqual([CODE, ''])
    } finally {
      timers.restore()
    }
  })
})
