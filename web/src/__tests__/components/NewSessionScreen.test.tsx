import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import { act, cleanup, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { CodingWorkspaceTreeResponse, SessionResponse } from '@/api/types'
import { queryKeys } from '@/queries/keys'

const navigate = mock((..._args: unknown[]) => {})
mock.module('@tanstack/react-router', () => ({ useNavigate: () => navigate }))

import {
  NewSessionScreen,
  recentFolders,
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
}: {
  workspace?: string
  isChat?: boolean
  isMobile?: boolean
  leaving?: boolean
  composerPlaceholderHeight?: number
  here?: SessionResponse[]
  everywhere?: SessionResponse[]
} = {}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })
  client.setQueryData(queryKeys.coding.tree(), tree)
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
  it('asks what to build in a repository and shows its branch', () => {
    renderScreen()
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('What should we build in openagentd?')
    expect(screen.getByRole('button', { name: 'Folder: openagentd. Change folder' })).toBeTruthy()
    expect(screen.getByText('main')).toBeTruthy()
  })

  it('asks anything in Chat, without a branch or a Chat chip', () => {
    renderScreen({ workspace: CHAT.path, isChat: true })
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Ask anything')
    expect(screen.queryByText('main')).toBeNull()
    const folders = screen.getByRole('region', { name: 'Recent folders' })
    expect(within(folders).queryByRole('button', { name: 'Chat' })).toBeNull()
  })

  it('offers recent folders, Chat and Open folder… as one-click switches', async () => {
    const user = userEvent.setup()
    const { onSelectWorkspace, onOpenFolder } = renderScreen({
      everywhere: [session('a', 'Landing copy', '/work/agent-sdk'), session('b', 'Here', REPO)],
    })
    const folders = screen.getByRole('region', { name: 'Recent folders' })
    // Recently active first, then the sidebar's order; never the current one.
    expect(within(folders).getAllByRole('button').map((chip) => chip.textContent)).toEqual([
      'agent-sdk',
      'web-landing',
      'Chat',
      'Open folder…',
    ])

    await user.click(within(folders).getByRole('button', { name: 'web-landing' }))
    expect(onSelectWorkspace).toHaveBeenCalledWith('/work/web-landing')
    await user.click(within(folders).getByRole('button', { name: 'Chat' }))
    expect(onSelectWorkspace).toHaveBeenLastCalledWith(CHAT.path)
    await user.click(within(folders).getByRole('button', { name: 'Open folder…' }))
    expect(onOpenFolder).toHaveBeenCalledTimes(1)
  })

  it("lists this folder's recent sessions and opens one", async () => {
    const user = userEvent.setup()
    renderScreen({ here: [session('s-1', 'Sidebar redesign', REPO), session('s-2', 'Fix tray label', REPO)] })

    const recent = screen.getByRole('region', { name: 'Recent sessions in openagentd' })
    await user.click(within(recent).getByText('Sidebar redesign'))
    expect(navigate).toHaveBeenCalledWith({ to: '/$sessionId', params: { sessionId: 's-1' } })
  })

  it('has no starter prompts: the composer is the call to action', () => {
    renderScreen()
    const buttons = screen.getAllByRole('button').map((button) => button.textContent ?? '')
    // Only the folder picker and the folder chips are buttons here.
    expect(buttons.every((text) => !/explain|review|write|fix|summari[sz]e/i.test(text))).toBe(true)
  })

  it('hosts the composer when centered and shows the shortcut hints on desktop', () => {
    renderScreen()
    expect(screen.getByRole('textbox', { name: 'Composer' })).toBeTruthy()
    expect(screen.getByLabelText('Shortcuts').textContent).toContain('commands')
    expect(screen.queryByText(/Start typing/)).toBeNull()
  })

  it('left-aligns the centered composer so typed text starts at the caret', () => {
    // The hero is `text-center`; the composer must not inherit it, or typed
    // text centers while the caret sits at the left edge of an empty line.
    renderScreen()
    const slot = screen.getByRole('textbox', { name: 'Composer' }).parentElement
    expect(slot?.className).toContain('text-left')
  })

  it('leaves the composer docked and drops the hints on mobile', () => {
    renderScreen({ isMobile: true, here: [session('s-1', 'Sidebar redesign', REPO)] })
    expect(screen.queryByRole('textbox', { name: 'Composer' })).toBeNull()
    expect(screen.queryByText(/Start typing/)).toBeNull()
    expect(screen.queryByLabelText('Shortcuts')).toBeNull()
    expect(screen.getByRole('region', { name: 'Recent sessions' })).toBeTruthy()
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

describe('recentFolders', () => {
  it('dedupes, skips the current folder and Chat, and caps the list', () => {
    const sessions = [
      session('1', 'a', '/work/b'),
      session('2', 'b', REPO),
      session('3', 'c', '/work/b'),
      session('4', 'd', CHAT.path),
    ]
    expect(recentFolders(sessions, tree.repositories, REPO, CHAT.path, 3)).toEqual(['/work/b', '/work/web-landing', '/work/agent-sdk'])
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
      'Open folder…',
    ])
    expect(within(listbox).getByRole('option', { name: 'openagentd' }).getAttribute('aria-selected')).toBe('true')

    await user.type(screen.getByRole('combobox', { name: 'Filter folders' }), 'land')
    expect(within(listbox).getAllByRole('option').map((option) => option.textContent)).toEqual(['web-landing', 'Open folder…'])
    await user.keyboard('{Enter}')
    expect(onSelectWorkspace).toHaveBeenCalledWith('/work/web-landing')
  })

  it('reaches Open folder… with the arrows', async () => {
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
