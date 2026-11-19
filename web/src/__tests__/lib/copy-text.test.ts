/**
 * Copy from a menu or an icon button: the menu has closed by the time the
 * text is on the clipboard, so the app says "Copied" (or that it could
 * not), and a phone gives a soft tap.
 */
import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'

const haptics: string[] = []
const realHaptics = await import('@/lib/haptics')
mock.module('@/lib/haptics', () => ({ ...realHaptics, softHapticFeedback: () => { haptics.push('soft') } }))

import { copyText } from '@/lib/copy-text'
import { useToastStore } from '@/stores/useToastStore'

const realClipboard = Object.getOwnPropertyDescriptor(navigator, 'clipboard')

function clipboard(writeText: (text: string) => Promise<void>) {
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
}

beforeEach(() => {
  haptics.length = 0
  useToastStore.setState({ toasts: [] })
})

afterEach(() => {
  if (realClipboard) Object.defineProperty(navigator, 'clipboard', realClipboard)
})

describe('copyText', () => {
  it('says Copied, with a soft tap, once the text is on the clipboard', async () => {
    const written: string[] = []
    clipboard(async (text) => { written.push(text) })

    expect(await copyText('src/main.rs')).toBe(true)

    expect(written).toEqual(['src/main.rs'])
    expect(useToastStore.getState().toasts.map((t) => [t.tone, t.title])).toEqual([['success', 'Copied']])
    expect(haptics).toEqual(['soft'])
  })

  it('says it could not copy when the clipboard refuses', async () => {
    clipboard(async () => { throw new Error('denied') })

    expect(await copyText('x')).toBe(false)

    expect(useToastStore.getState().toasts.map((t) => [t.tone, t.title])).toEqual([['error', "Couldn't copy"]])
    expect(haptics).toEqual([])
  })
})
