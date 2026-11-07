/**
 * On desktop, Esc in an empty composer stops the running turn, as in agent
 * CLIs (desktop mockup 5.1). A draft, an open menu or an idle agent keep
 * Escape for themselves, and a phone has no Esc key to press.
 */
import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

let isMobile = false
mock.module('@/hooks/use-platform', () => ({
  usePlatform: () => ({ isTauri: false, os: 'macos', isMacOverlay: false }),
  getPlatform: () => ({ isTauri: false, os: 'macos', isMacOverlay: false }),
}))
mock.module('@/hooks/use-mobile', () => ({ useIsMobile: () => isMobile }))

import { InputComposer } from '@/components/InputComposer'
import { pushLayer, removeLayer } from '@/lib/keyboard/layers'

beforeEach(() => {
  isMobile = false
})
afterEach(cleanup)

function renderRunning() {
  const onStop = mock(() => {})
  render(<InputComposer onSubmit={() => {}} onStop={onStop} isStreaming />)
  const input = screen.getByLabelText('Message input')
  input.focus()
  return { onStop, input }
}

describe('InputComposer — Esc stops the run on desktop', () => {
  it('stops the running turn on Esc in an empty composer', async () => {
    const { onStop } = renderRunning()
    await userEvent.setup().keyboard('{Escape}')
    expect(onStop).toHaveBeenCalledTimes(1)
  })

  it('leaves the run alone while the composer holds a draft', async () => {
    const { onStop } = renderRunning()
    const user = userEvent.setup()
    await user.type(screen.getByLabelText('Message input'), 'wait')
    await user.keyboard('{Escape}')
    expect(onStop).not.toHaveBeenCalled()
  })

  it('closes an open menu first', async () => {
    const { onStop } = renderRunning()
    const close = mock(() => {})
    const id = pushLayer({ kind: 'transient', close })
    try {
      await userEvent.setup().keyboard('{Escape}')
    } finally {
      removeLayer(id)
    }
    expect(close).toHaveBeenCalledTimes(1)
    expect(onStop).not.toHaveBeenCalled()
  })

  it('does nothing while the agent is idle', async () => {
    const onStop = mock(() => {})
    render(<InputComposer onSubmit={() => {}} onStop={onStop} />)
    screen.getByLabelText('Message input').focus()
    await userEvent.setup().keyboard('{Escape}')
    expect(onStop).not.toHaveBeenCalled()
  })

  it('is not a phone gesture', async () => {
    isMobile = true
    const { onStop } = renderRunning()
    await userEvent.setup().keyboard('{Escape}')
    expect(onStop).not.toHaveBeenCalled()
  })

  it('names the key on the Stop button', () => {
    renderRunning()
    expect(screen.getByRole('button', { name: 'Stop generation' }).getAttribute('aria-keyshortcuts')).toBe('Escape')
  })
})
