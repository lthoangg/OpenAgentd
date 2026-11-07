import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { CodingWorkspaceTreeResponse, SessionResponse } from '@/api/types'
import { queryKeys } from '@/queries/keys'

const navigate = mock((..._args: unknown[]) => {})
mock.module('@tanstack/react-router', () => ({ useNavigate: () => navigate }))

import {
  NewSessionScreen,
} from '@/components/NewSession/NewSessionScreen'

const realFetch = globalThis.fetch
const REPO = '/work/openagentd'
const CHAT = { path: '/home/user', name: 'Chat' }

const tree: CodingWorkspaceTreeResponse = {
  repositories: [
    { path: REPO, name: 'openagentd', worktrees: [{ path: '/wt/sidebar', name: 'wt-sidebar', managed: true }] },
    { path: '/work/web-landing', name: 'web-landing', worktrees: [] },
    { path: '/work/agent-sdk', name: 'agent-sdk', worktrees: [] },
  ],
  chat: CHAT,
}

function session(id: string, title: string, workspace: string, extra: Partial<SessionResponse> = {}): SessionResponse {
  const at = new Date().toISOString()
  return { id, title, workspace, agent_name: 'code', created_at: at, updated_at: at, ...extra }
}

const page = (data: SessionResponse[]) => ({ pages: [{ data, has_more: false, next_cursor: null }], pageParams: [null] })

function renderScreen({
  workspace = REPO,
  isChat = false,
  isMobile = false,
  leaving = false,
  composerPlaceholderHeight,
  here = [],
  everywhere = [],
  phone = false,
}: {
  workspace?: string
  isChat?: boolean
  isMobile?: boolean
  leaving?: boolean
  composerPlaceholderHeight?: number
  here?: SessionResponse[]
  everywhere?: SessionResponse[]
  phone?: boolean
} = {}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })
  client.setQueryData(queryKeys.coding.tree(), tree)
  // A repository with a branch: the screen must still not show it, nor ask for it.
  client.setQueryData(queryKeys.coding.status(workspace), { is_git_repo: true, branch: 'main' })
  client.setQueryData(queryKeys.session.sessions.workspace(workspace, 'activity'), page(here))
  client.setQueryData(queryKeys.session.sessions.everywhere('activity'), page(everywhere))
  const onSelectWorkspace = mock((..._args: unknown[]) => {})
  const onOpenFolder = mock(() => {})
  render(
    <QueryClientProvider client={client}>
      <NewSessionScreen
        workspace={workspace}
        workspaceName={isChat ? 'Chat' : workspace.split('/').pop()!}
        isChat={isChat}
        chatWorkspace={CHAT}
        // As AgentChatView does: the composer sits here on desktop only.
        composer={isMobile || leaving ? null : <textarea aria-label="Composer" />}
        isMobile={isMobile}
        phone={phone}
        leaving={leaving}
        composerPlaceholderHeight={composerPlaceholderHeight}
        onSelectWorkspace={onSelectWorkspace}
        onOpenFolder={onOpenFolder}
      />
    </QueryClientProvider>,
  )
  return { onSelectWorkspace, onOpenFolder }
}

beforeEach(() => {
  globalThis.fetch = mock(() => new Promise<Response>(() => {})) as unknown as typeof fetch
})

afterEach(() => {
  cleanup()
  navigate.mockClear()
  globalThis.fetch = realFetch
})

describe('NewSessionScreen', () => {
  it('on a phone: only the folder chip, no suggestions, heading or Continue', () => {
    renderScreen({ isMobile: true, phone: true, here: [session('s1', 'Earlier work', REPO)] })

    expect(screen.queryByRole('heading', { level: 1 })).toBeNull()
    expect(screen.queryByText('Continue')).toBeNull()
    expect(screen.getByRole('button', { name: 'Folder: openagentd. Change folder' })).toBeTruthy()
    expect(screen.queryByRole('list', { name: 'Suggestions' })).toBeNull()
  })

  it('asks what to build in a repository, with the folder chip and no branch: the status bar has it', () => {
    renderScreen()
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('What should we build in openagentd?')
    expect(screen.getByRole('button', { name: 'Folder: openagentd. Change folder' })).toBeTruthy()
    expect(screen.queryByText('main')).toBeNull()
  })

  it('does not fetch the git status: nothing here shows it', async () => {
    const fetchMock = globalThis.fetch as unknown as ReturnType<typeof mock>
    // Mount with a cold cache for this workspace's status.
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    client.setQueryData(queryKeys.coding.tree(), tree)
    render(
      <QueryClientProvider client={client}>
        <NewSessionScreen
          workspace={REPO}
          workspaceName="openagentd"
          isChat={false}
          chatWorkspace={CHAT}
          isMobile={false}
          onSelectWorkspace={() => {}}
          onOpenFolder={() => {}}
        />
      </QueryClientProvider>,
    )
    // The recent-sessions request goes out; the status one must not.
    await waitFor(() => expect(fetchMock.mock.calls.length).toBeGreaterThan(0))
    const urls = fetchMock.mock.calls.map((call) => String(call[0]))
    expect(urls.some((url) => url.includes('/workspace/status'))).toBe(false)
  })

  it('asks anything in Chat, without a branch', () => {
    renderScreen({ workspace: CHAT.path, isChat: true })
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Ask anything')
    expect(screen.queryByText('main')).toBeNull()
  })

  it('labels the folder picker with "in", so it reads as a place, not a mode', () => {
    renderScreen()
    expect(screen.getByRole('button', { name: 'Folder: openagentd. Change folder' }).textContent).toContain('in')
  })

  it('has no second folder list: other folders live in the picker', () => {
    renderScreen({ everywhere: [session('a', 'Landing copy', '/work/agent-sdk')] })
    expect(screen.queryByRole('region', { name: 'Recent folders' })).toBeNull()
  })

  it('lists at most three sessions under Continue', () => {
    renderScreen({ here: ['1', '2', '3', '4', '5'].map((id) => session(`s-${id}`, `Session ${id}`, REPO)) })
    const recent = screen.getByRole('region', { name: 'Continue' })
    expect(within(recent).queryByText('Session 3')).toBeTruthy()
    expect(within(recent).queryByText('Session 4')).toBeNull()
  })

  it("lists this folder's recent sessions and opens one", async () => {
    const user = userEvent.setup()
    renderScreen({ here: [session('s-1', 'Sidebar redesign', REPO), session('s-2', 'Fix tray label', REPO)] })

    const recent = screen.getByRole('region', { name: 'Continue' })
    await user.click(within(recent).getByText('Sidebar redesign'))
    expect(navigate).toHaveBeenCalledWith({ to: '/$sessionId', params: { sessionId: 's-1' } })
  })

  it('has no starter prompts: the composer is the call to action', () => {
    renderScreen()
    const buttons = screen.getAllByRole('button').map((button) => button.textContent ?? '')
    // Only the folder picker and the folder chips are buttons here.
    expect(buttons.every((text) => !/explain|review|write|fix|summari[sz]e/i.test(text))).toBe(true)
  })

  it('hosts the composer when centered, with no hint line under it', () => {
    renderScreen()
    expect(screen.getByRole('textbox', { name: 'Composer' })).toBeTruthy()
    expect(screen.queryByLabelText('Shortcuts')).toBeNull()
    expect(screen.queryByText(/for commands/)).toBeNull()
    expect(screen.queryByText(/Start typing/)).toBeNull()
  })

  it('left-aligns the centered composer so typed text starts at the caret', () => {
    // The hero is `text-center`; the composer must not inherit it, or typed
    // text centers while the caret sits at the left edge of an empty line.
    renderScreen()
    const slot = screen.getByRole('textbox', { name: 'Composer' }).parentElement
    expect(slot?.className).toContain('text-left')
  })

  it('leaves the composer docked on mobile', () => {
    renderScreen({ isMobile: true, here: [session('s-1', 'Sidebar redesign', REPO)] })
    expect(screen.queryByRole('textbox', { name: 'Composer' })).toBeNull()
    expect(screen.queryByText(/Start typing/)).toBeNull()
    expect(screen.queryByLabelText('Shortcuts')).toBeNull()
    expect(screen.getByRole('region', { name: 'Continue' })).toBeTruthy()
  })

  it('fades out as an inert copy that holds the composer’s place while leaving', () => {
    renderScreen({ leaving: true, composerPlaceholderHeight: 96 })
    const leaving = screen.getByTestId('new-session-screen-leaving')
    expect(leaving.getAttribute('aria-hidden')).toBe('true')
    expect(leaving.hasAttribute('inert')).toBe(true)
    expect(screen.queryByTestId('new-session-screen')).toBeNull()
    expect(screen.queryByRole('textbox', { name: 'Composer' })).toBeNull()
    const placeholder = leaving.querySelector('[data-composer-placeholder]') as HTMLElement | null
    expect(placeholder?.style.height).toBe('96px')
  })
})


describe('WorkspacePicker', () => {
  it('filters folders and picks one with the keyboard', async () => {
    const user = userEvent.setup()
    const { onSelectWorkspace } = renderScreen()
    await user.click(screen.getByRole('button', { name: 'Folder: openagentd. Change folder' }))

    const listbox = await screen.findByRole('listbox', { name: 'Folders' })
    expect(within(listbox).getAllByRole('option').map((option) => option.textContent)).toEqual([
      'Chat',
      'openagentd',
      'wt-sidebar',
      'web-landing',
      'agent-sdk',
      'Open workspace…',
    ])
    expect(within(listbox).getByRole('option', { name: 'openagentd' }).getAttribute('aria-selected')).toBe('true')

    await user.type(screen.getByRole('combobox', { name: 'Filter folders' }), 'land')
    expect(within(listbox).getAllByRole('option').map((option) => option.textContent)).toEqual(['web-landing', 'Open workspace…'])
    await user.keyboard('{Enter}')
    expect(onSelectWorkspace).toHaveBeenCalledWith('/work/web-landing')
  })

  it('reaches Open workspace… with the arrows', async () => {
    const user = userEvent.setup()
    const { onOpenFolder } = renderScreen()
    await user.click(screen.getByRole('button', { name: 'Folder: openagentd. Change folder' }))
    await screen.findByRole('listbox', { name: 'Folders' })

    await user.keyboard('{End}{Enter}')
    expect(onOpenFolder).toHaveBeenCalledTimes(1)
  })

  it('closes on Escape and gives focus back to the chip', async () => {
    const user = userEvent.setup()
    renderScreen()
    const chip = screen.getByRole('button', { name: 'Folder: openagentd. Change folder' })
    await user.click(chip)
    await screen.findByRole('listbox', { name: 'Folders' })

    await user.keyboard('{Escape}')
    expect(chip.getAttribute('aria-expanded')).toBe('false')
    expect(document.activeElement).toBe(chip)
    // The panel plays its exit before it unmounts.
    await act(() => new Promise((resolve) => setTimeout(resolve, 300)))
    expect(screen.queryByRole('listbox')).toBeNull()
  })
})
