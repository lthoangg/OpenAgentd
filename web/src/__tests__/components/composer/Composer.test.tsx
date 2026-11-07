/**
 * The docked composer and its run deck: always open in the column's flow,
 * the run chip reading ``model · Level · Account`` (``provider:model`` in its
 * tooltip), and the "+" menu.
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
    accounts: null, credentialId: null, pinnedAccount: null, inUseAccount: null,
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
  it('names the model in sans, then the level and the account in use', () => {
    const account = { id: 'w', label: 'Work', disabled: false, kind: 'oauth' as const, hint: null, settings: {}, status: 'ready' as const, in_use: false, cooldown_until: null, cooldown_reason: null }
    wrap(<RunChip settings={runSettings({ inUseAccount: account, accounts: [account, { ...account, id: 'h', label: 'Home' }] })} />)
    const chip = document.querySelector('[data-run-chip]') as HTMLElement
    expect(chip.textContent).toBe('claude-sonnet-4-5·High · Work')
    expect(chip.getAttribute('aria-label')).toMatch(/^Model anthropic:claude-sonnet-4-5, thinking High, account Work\. Change/)
    expect(chip.querySelector('.font-mono')).toBeNull()
    expect(chip.querySelector('[data-run-chip-model]')?.textContent).toBe('claude-sonnet-4-5')
  })

  it('names provider:model in mono in its tooltip, with the shortcut', async () => {
    wrap(<RunChip settings={runSettings()} />)
    const chip = document.querySelector('[data-run-chip]') as HTMLElement

    fireEvent.mouseEnter(chip.parentElement!)
    // The hover hint waits 500ms (ui/tooltip); a loaded runner needs the slack.
    const tip = await screen.findByRole('tooltip', undefined, { timeout: 3000 })
    expect(tip.querySelector('.font-mono')?.textContent).toBe('anthropic:claude-sonnet-4-5')
    expect(tip.textContent).toMatch(/^anthropic:claude-sonnet-4-5 · Change \((⌘|Ctrl\+)\.\)$/)
  })

  it('names the account a locked session moved to, never Auto', () => {
    const account = { id: 'w', label: 'Work', disabled: false, kind: 'oauth' as const, hint: null, settings: {}, status: 'cooling_down' as const, in_use: false, cooldown_until: null, cooldown_reason: null }
    const home = { ...account, id: 'h', label: 'Home', status: 'ready' as const }
    wrap(<RunChip settings={runSettings({ pinnedAccount: account, credentialId: 'w', inUseAccount: home, accounts: [account, home] })} />)
    const chip = document.querySelector('[data-run-chip]') as HTMLElement
    expect(chip.textContent).toContain('Home')
    expect(chip.getAttribute('aria-label')).not.toContain('Auto')
  })

  it('keeps the end of a long model name when it truncates, and stacks under 520px', () => {
    wrap(<RunChip settings={runSettings()} />)
    const chip = document.querySelector('[data-run-chip]') as HTMLElement
    const line = chip.querySelector('[data-run-chip-model]') as HTMLElement
    expect(line.className).toContain('h-[1lh]')
    // ui/model-name's ModelPart: the start gives way, the end (`sonnet-4-5`) stays whole.
    const [head, tail] = Array.from(line.firstElementChild!.children)
    expect(head.textContent).toBe('claude-')
    expect(head.className).toContain('truncate')
    expect(tail.textContent).toBe('sonnet-4-5')
    expect(tail.className).toContain('whitespace-nowrap')
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

  // ⌘. then close left focus on the chip, with its ring: Tab then moved
  // through the page instead of switching Code/Plan in the message box.
  it('hands focus back to the message box it was opened from with ⌘.', async () => {
    wrap(
      <div>
        <textarea aria-label="Message input" />
        <RunChip settings={runSettings()} />
      </div>,
    )
    const input = screen.getByRole('textbox', { name: 'Message input' })
    input.focus()
    act(() => useUIStore.getState().toggleRunPicker())
    const search = await screen.findByRole('searchbox', { name: 'Search models' })
    await act(async () => { await new Promise((r) => requestAnimationFrame(r)) })
    expect(document.activeElement).toBe(search)

    act(() => useUIStore.getState().toggleRunPicker())
    expect(document.activeElement).toBe(input)
    expect(document.activeElement).not.toBe(document.querySelector('[data-run-chip]'))
  })

  it('hands focus back to the chip when the keyboard reached the chip first', async () => {
    wrap(
      <div>
        <textarea aria-label="Message input" />
        <RunChip settings={runSettings()} />
      </div>,
    )
    const chip = document.querySelector('[data-run-chip]') as HTMLElement
    chip.focus()
    fireEvent.click(chip)
    const search = await screen.findByRole('searchbox', { name: 'Search models' })
    fireEvent.keyDown(search, { key: 'Escape' })
    expect(document.activeElement).toBe(chip)
  })

  it('falls back to the message box when the picker was opened from nowhere in particular', async () => {
    wrap(
      <div>
        <textarea aria-label="Message input" />
        <RunChip settings={runSettings()} />
      </div>,
    )
    ;(document.activeElement as HTMLElement | null)?.blur()
    fireEvent.click(document.querySelector('[data-run-chip]') as HTMLElement)
    const search = await screen.findByRole('searchbox', { name: 'Search models' })
    search.focus()
    fireEvent.keyDown(search, { key: 'Escape' })
    expect(document.activeElement).toBe(screen.getByRole('textbox', { name: 'Message input' }))
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

describe('PlusMenu — MCP attention', () => {
  // MCP lives in "+", so the deck has no MCP button of its own: "+" carries
  // a dot while a server needs the user, and opens at the MCP section.
  it('marks + with a dot while a server needs the user, and says which', () => {
    const actions = { attach: () => {}, startToken: () => {}, setDraft: () => {} }
    wrap(<PlusMenu actions={actions} workspace="/repo" />)
    const plus = screen.getByRole('button', { name: 'Add to message', description: 'github needs sign-in' })
    expect(plus.querySelector('[data-mcp-attention]')).toBeTruthy()
  })

  it('opens at the MCP section while a server needs the user', async () => {
    const actions = { attach: () => {}, startToken: () => {}, setDraft: () => {} }
    wrap(<PlusMenu actions={actions} workspace="/repo" />)
    fireEvent.click(screen.getByRole('button', { name: 'Add to message' }))
    expect(useUIStore.getState().plusMenuSection).toBe('mcp')
    expect(await screen.findByRole('region', { name: 'MCP servers' })).toBeTruthy()
  })
})
