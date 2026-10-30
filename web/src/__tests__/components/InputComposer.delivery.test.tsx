/**
 * While a turn runs, a message can steer it (the default), wait for it to end,
 * or stop it and go in its place. Keyboard and the split Send offer all three.
 */
import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

let mockOS = 'macos'
let isMobile = false
mock.module('@/hooks/use-platform', () => ({
  usePlatform: () => ({ isTauri: false, os: mockOS, isMacOverlay: false }),
  getPlatform: () => ({ isTauri: false, os: mockOS, isMacOverlay: false }),
}))
mock.module('@/hooks/use-mobile', () => ({ useIsMobile: () => isMobile }))

import { InputComposer } from '@/components/InputComposer'

beforeEach(() => {
  mockOS = 'macos'
  isMobile = false
})
afterEach(cleanup)

async function typeWhileStreaming(text = 'follow-up') {
  const onSubmit = mock((..._args: unknown[]) => {})
  const user = userEvent.setup()
  render(<InputComposer onSubmit={onSubmit} onStop={() => {}} isStreaming />)
  await user.type(screen.getByLabelText('Message input'), text)
  return { onSubmit, user }
}

const deliveryOf = (onSubmit: ReturnType<typeof mock>) => onSubmit.mock.calls[0]?.[3]

/** The chevron menu loads on demand; its trigger stands in until then. */
const moreWaysToSend = () => screen.findByRole('button', { name: 'More ways to send' })

describe('InputComposer — delivery keys while a turn runs', () => {
  it('steers the running turn on Enter', async () => {
    const { onSubmit, user } = await typeWhileStreaming()
    await user.keyboard('{Enter}')
    expect(onSubmit.mock.calls[0]).toEqual(['follow-up', undefined, undefined, 'steer'])
  })

  it('queues until the turn is done on Alt+Enter', async () => {
    const { onSubmit, user } = await typeWhileStreaming()
    await user.keyboard('{Alt>}{Enter}{/Alt}')
    expect(deliveryOf(onSubmit)).toBe('after-turn')
  })

  it('stops the turn and sends on ⌘Enter or Ctrl+Enter', async () => {
    const { onSubmit, user } = await typeWhileStreaming()
    await user.keyboard('{Meta>}{Enter}{/Meta}')
    await user.type(screen.getByLabelText('Message input'), 'again')
    await user.keyboard('{Control>}{Enter}{/Control}')
    expect(onSubmit.mock.calls.map((call) => call[3])).toEqual(['interrupt', 'interrupt'])
  })

  it('sends normally on any Enter while idle', async () => {
    const onSubmit = mock((..._args: unknown[]) => {})
    const user = userEvent.setup()
    render(<InputComposer onSubmit={onSubmit} />)
    await user.type(screen.getByLabelText('Message input'), 'hello')
    await user.keyboard('{Alt>}{Enter}{/Alt}')
    expect(deliveryOf(onSubmit)).toBe('steer')
  })
})

describe('InputComposer — split Send', () => {
  it('splits Send only while a turn runs and there is text to send', async () => {
    const user = userEvent.setup()
    const { rerender } = render(<InputComposer onSubmit={() => {}} onStop={() => {}} />)
    await user.type(screen.getByLabelText('Message input'), 'hi')
    expect(screen.getByRole('button', { name: 'Send message' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'More ways to send' })).toBeNull()

    rerender(<InputComposer onSubmit={() => {}} onStop={() => {}} isStreaming />)
    expect(screen.getByRole('button', { name: 'Steer the running turn' })).toBeTruthy()
    expect(await moreWaysToSend()).toBeTruthy()

    await user.clear(screen.getByLabelText('Message input'))
    expect(screen.getByRole('button', { name: 'Stop generation' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'More ways to send' })).toBeNull()
  })

  it('sizes both halves of the split Send, and the composer controls, to 36px on a phone', async () => {
    await typeWhileStreaming()
    const steer = screen.getByRole('button', { name: 'Steer the running turn' })
    const chevron = await moreWaysToSend()
    // jsdom has no layout: the shared phone-touch height class is the contract.
    for (const el of [steer, chevron, screen.getByRole('button', { name: 'Attach file' })]) {
      expect(el.className).toContain('max-md:pointer-coarse:h-9')
    }
  })

  it('lists each way to send with its shortcut', async () => {
    const { user } = await typeWhileStreaming()
    await user.click(await moreWaysToSend())

    const items = screen.getAllByRole('menuitem')
    expect(items.map((item) => item.getAttribute('aria-label'))).toEqual(['Steer', 'Queue until done', 'Stop & send'])
    expect(items.map((item) => item.getAttribute('aria-keyshortcuts'))).toEqual(['Enter', 'Alt+Enter', 'Meta+Enter'])
    expect(items.map((item) => item.querySelector('kbd')?.textContent)).toEqual(['↵', '⌥↵', '⌘↵'])
    expect(screen.getByText('Sends when this turn ends')).toBeTruthy()
  })

  it('spells the shortcuts out off macOS', async () => {
    mockOS = 'linux'
    const { user } = await typeWhileStreaming()
    await user.click(await moreWaysToSend())

    const items = screen.getAllByRole('menuitem')
    expect(items.map((item) => item.querySelector('kbd')?.textContent)).toEqual(['↵', 'Alt+↵', 'Ctrl+↵'])
    expect(items[2].getAttribute('aria-keyshortcuts')).toBe('Control+Enter')
  })

  it('leaves shortcut hints off on a phone', async () => {
    isMobile = true
    const { user } = await typeWhileStreaming()
    await user.click(await moreWaysToSend())

    expect(screen.getAllByRole('menuitem').some((item) => item.querySelector('kbd'))).toBe(false)
  })

  it('sends the draft the way the menu item says', async () => {
    const { onSubmit, user } = await typeWhileStreaming()
    await user.click(await moreWaysToSend())
    await user.click(screen.getByRole('menuitem', { name: 'Queue until done' }))

    expect(onSubmit.mock.calls[0]).toEqual(['follow-up', undefined, undefined, 'after-turn'])
    expect((screen.getByLabelText('Message input') as HTMLTextAreaElement).value).toBe('')
  })
})
