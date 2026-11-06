import { afterEach, describe, expect, it, mock } from 'bun:test'

mock.module('lucide-react', () => new Proxy({}, { get: () => () => null }))

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { ProviderSetupNotice } from '@/components/AgentChatView/ProviderSetupNotice'

afterEach(cleanup)

function renderNotice(props: Partial<Parameters<typeof ProviderSetupNotice>[0]> = {}) {
  const onOpenProviders = mock(() => {})
  const onDismiss = mock(() => {})
  render(
    <ProviderSetupNotice
      setupMessage={null}
      hasConfiguredProvider
      onOpenProviders={onOpenProviders}
      onDismiss={onDismiss}
      {...props}
    />,
  )
  return { onOpenProviders, onDismiss }
}

describe('ProviderSetupNotice', () => {
  it('stays hidden once a provider is configured and nothing failed', () => {
    renderNotice()
    expect(screen.queryByRole('status')).toBeNull()
  })

  it('asks for a provider when none is configured, without a dismiss', () => {
    const { onOpenProviders } = renderNotice({ hasConfiguredProvider: false })

    expect(screen.getByRole('status').textContent).toContain('Connect a model provider')
    expect(screen.queryByRole('button', { name: 'Dismiss provider setup notice' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Open providers' }))
    expect(onOpenProviders).toHaveBeenCalledTimes(1)
  })

  it("shows the server's reason when a send needs setup, and can be dismissed", () => {
    const { onDismiss } = renderNotice({ setupMessage: 'The lead model needs an API key.' })

    expect(screen.getByRole('status').textContent).toContain('The lead model needs an API key.')
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss provider setup notice' }))
    expect(onDismiss).toHaveBeenCalledTimes(1)
  })

  it('offers no dismiss when dismissing would only reveal the same notice', () => {
    renderNotice({ setupMessage: 'The lead model needs an API key.', hasConfiguredProvider: false })

    expect(screen.getAllByRole('status')).toHaveLength(1)
    expect(screen.queryByRole('button', { name: 'Dismiss provider setup notice' })).toBeNull()
  })

  it("names the session model's provider when only that one is missing, and offers another model", () => {
    // "Connect a model provider" read as if none were set up while nine were.
    const onChooseModel = mock(() => {})
    renderNotice({
      hasConfiguredProvider: false,
      missingProvider: { label: 'Antigravity', model: 'agy:antigravity-claude-sonnet-4-6' },
      onChooseModel,
    })

    const status = screen.getByRole('status')
    expect(status.textContent).toContain('Connect Antigravity to keep chatting')
    expect(status.textContent).toContain('agy:antigravity-claude-sonnet-4-6')
    expect(status.textContent).not.toContain('Connect a model provider')
    fireEvent.click(screen.getByRole('button', { name: 'Choose model' }))
    expect(onChooseModel).toHaveBeenCalledTimes(1)
  })
})
