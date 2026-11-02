/**
 * The docked composer and its run deck: always open in the column's flow,
 * the run chip reading ``provider:model · Level · Account``, and the "+" menu.
 */
import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ReactNode } from 'react'

mock.module('@/hooks/use-mobile', () => ({ useIsMobile: () => false }))
mock.module('@/queries/useAgentsQuery', () => ({
  useAgentsQuery: () => ({ data: { agents: [{ name: 'code', mcp_servers: ['github'], tools: [] }] }, refetch: async () => {} }),
}))
mock.module('@/queries/useMcpQuery', () => ({
  useMcpServersQuery: () => ({
    data: { servers: [{ name: 'github', enabled: true, state: 'auth_required', tool_names: [], transport: 'http', config: null, error: null }] },
    isLoading: false,
    isError: false,
    refetch: async () => {},
  }),
  useUpdateMcpServerMutation: () => ({ mutate: () => {}, isPending: false }),
  useConnectMcpOAuthMutation: () => ({ mutate: () => {}, isPending: false }),
}))

const { Composer } = await import('@/components/composer/Composer')
const { RunChip } = await import('@/components/composer/RunChip')
const { PlusMenu } = await import('@/components/composer/PlusMenu')
const { McpAttentionChip } = await import('@/components/composer/McpAttentionChip')
const { useUIStore } = await import('@/stores/useUIStore')
type RunSettings = import('@/components/composer/useRunSettings').RunSettings

afterEach(cleanup)
beforeEach(() => {
  useUIStore.setState({ runPickerOpen: false, plusMenuOpen: false, plusMenuSection: null })
})

function wrap(node: ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, enabled: false } } })
  return render(<QueryClientProvider client={client}>{node}</QueryClientProvider>)
}

function runSettings(over: Partial<RunSettings> = {}): RunSettings {
  return {
    agentName: 'code', agentModel: 'anthropic:claude-sonnet-4-5', agentThinkingLevel: null,
    model: 'anthropic:claude-sonnet-4-5', provider: 'anthropic', thinkingLevel: 'high', customized: false,
    thinkingLevels: ['low', 'high'], models: [], modelsLoading: false, providerInfo: undefined,
    accounts: null, credentialId: null, pinnedAccount: null,
    ...over,
  }
}

describe('Composer (docked)', () => {
  it('sits in the column flow at the prose width, with no drag grip and no collapse', () => {
    wrap(<Composer onSubmit={() => {}} />)
    const docked = screen.getByTestId('docked-composer')
    expect(docked.className).toContain('shrink-0')
    expect(docked.className).not.toContain('absolute')
    expect(docked.firstElementChild?.className).toContain('max-w-3xl')
    expect(screen.queryByRole('button', { name: /drag/i })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Expand input bar' })).toBeNull()
  })

  it('renders the new-session composer inline instead', () => {
    wrap(<Composer onSubmit={() => {}} placement="inline" />)
    expect(screen.getByTestId('inline-inputbar-container')).toBeTruthy()
    expect(screen.queryByTestId('docked-composer')).toBeNull()
  })

  it('carries the deck it is given beside Send', () => {
    wrap(<Composer onSubmit={() => {}} deck={<span>deck-slot</span>} deckEnd={<span>ring-slot</span>} />)
    const deck = document.querySelector('[data-run-deck]') as HTMLElement
    expect(deck.textContent).toContain('deck-slot')
    expect(deck.textContent).toContain('ring-slot')
  })
})

describe('RunChip', () => {
  it('reads provider:model in mono, then the level and the pinned account', () => {
    const account = { id: 'w', label: 'Work', disabled: false, kind: 'oauth' as const, hint: null, settings: {}, status: 'ready' as const, in_use: false, cooldown_until: null, cooldown_reason: null }
    wrap(<RunChip settings={runSettings({ pinnedAccount: account, credentialId: 'w', accounts: [account, { ...account, id: 'h', label: 'Home' }] })} />)
    const chip = document.querySelector('[data-run-chip]') as HTMLElement
    expect(chip.textContent).toBe('anthropic:claude-sonnet-4-5·High · Work')
    expect(chip.getAttribute('aria-label')).toMatch(/^Model anthropic:claude-sonnet-4-5, thinking High, account Work\. Change/)
    expect(chip.querySelector('.font-mono')?.textContent).toBe('anthropic:claude-sonnet-4-5')
  })

  it('lets the provider part give way first, and stacks under 520px', () => {
    wrap(<RunChip settings={runSettings()} />)
    const chip = document.querySelector('[data-run-chip]') as HTMLElement
    const line = chip.querySelector('.font-mono') as HTMLElement
    const [provider, model] = Array.from(line.children)
    // Whole or not at all: never a clipped sliver of a letter (see
    // ui/model-name).
    expect(provider.className).toContain('whitespace-nowrap')
    expect(provider.className).not.toContain('truncate')
    expect(line.className).toContain('h-[1lh]')
    expect(line.className).toContain('flex-wrap')
    // The model never shrinks; capped at the chip's width it truncates only
    // once the provider part is gone.
    expect(model.className).toContain('shrink-0')
    expect(model.className).toContain('max-w-full')
    expect(chip.innerHTML).toContain('@max-[520px]:flex-col')
  })

  it('opens the run picker in one click', async () => {
    wrap(<RunChip settings={runSettings()} />)
    fireEvent.click(document.querySelector('[data-run-chip]') as HTMLElement)
    expect(useUIStore.getState().runPickerOpen).toBe(true)
    expect(await screen.findByRole('dialog', { name: 'Model and thinking' })).toBeTruthy()
  })

  it('closes the run picker on Escape from its search', async () => {
    wrap(<RunChip settings={runSettings()} />)
    fireEvent.click(document.querySelector('[data-run-chip]') as HTMLElement)
    const search = await screen.findByRole('searchbox', { name: 'Search models' })
    fireEvent.keyDown(search, { key: 'Escape' })
    expect(useUIStore.getState().runPickerOpen).toBe(false)
  })
})

describe('PlusMenu', () => {
  it('starts a file mention, a snippet or a side question in the draft', async () => {
    const actions = { attach: mock(() => {}), startToken: mock((_t: unknown) => {}), setDraft: mock((_t: unknown) => {}) }
    wrap(<PlusMenu actions={actions} workspace="/repo" canAskSideQuestion />)
    fireEvent.click(screen.getByRole('button', { name: 'Add to message' }))
    fireEvent.click(await screen.findByRole('button', { name: /Mention a file/ }))
    await act(async () => { await new Promise((r) => requestAnimationFrame(r)) })
    expect(actions.startToken).toHaveBeenCalledWith('@')

    fireEvent.click(screen.getByRole('button', { name: 'Add to message' }))
    fireEvent.click(await screen.findByRole('button', { name: /Ask a side question/ }))
    await act(async () => { await new Promise((r) => requestAnimationFrame(r)) })
    expect(actions.setDraft).toHaveBeenCalledWith('/btw ')
  })

  it('holds the MCP servers, with their state in words', async () => {
    const actions = { attach: () => {}, startToken: () => {}, setDraft: () => {} }
    wrap(<PlusMenu actions={actions} workspace="/repo" />)
    act(() => useUIStore.getState().openPlusMenu('mcp'))
    const section = await screen.findByRole('region', { name: 'MCP servers' })
    expect(section.textContent).toContain('github')
    expect(section.textContent).toContain('Needs sign-in')
  })
})

describe('McpAttentionChip', () => {
  it('shows only for a server that needs the user, and opens the + menu there', () => {
    wrap(<McpAttentionChip workspace="/repo" />)
    const chip = screen.getByRole('button', { name: /github: Sign in/ })
    fireEvent.click(chip)
    expect(useUIStore.getState().plusMenuOpen).toBe(true)
    expect(useUIStore.getState().plusMenuSection).toBe('mcp')
  })

  it('is the plug alone on a deck under 640px (a chat beside the panel), still named in full', () => {
    wrap(<McpAttentionChip workspace="/repo" />)
    const chip = screen.getByRole('button', { name: /github: Sign in/ })
    // A truncated "sla…" said nothing and starved the run chip of room.
    expect(chip.querySelector('span')?.className).toContain('@max-[640px]:hidden')
    expect(chip.className).toContain('@max-[640px]:w-6')
    expect(chip.className).toContain('pointer-coarse:@max-[640px]:w-9')
  })
})
