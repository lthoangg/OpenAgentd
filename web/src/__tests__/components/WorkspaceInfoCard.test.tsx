import { afterEach, describe, expect, it, mock } from 'bun:test'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import '@testing-library/jest-dom'

let requestCount = 0
const getCodingWorkspaceStatus = mock(async () => {
  requestCount += 1
  if (requestCount === 1) throw new Error('git status unavailable')
  return {
    name: 'workspace',
    is_git_repo: true,
    branch: 'main',
    dirty: { staged: 0, unstaged: 0, untracked: 0 },
    head: null,
  }
})

mock.module('@/api/client', () => ({ getCodingWorkspaceStatus }))

import { WorkspaceInfoCard } from '@/components/WorkspaceInfoCard'

/**
 * Force `useIsMobile` on or off by stubbing the shared MOBILE_QUERY match.
 * Returns a cleanup function.
 */
function mockIsMobile(isMobile: boolean) {
  const originalMatchMedia = window.matchMedia
  window.matchMedia = (query: string) => {
    if (query.includes('max-width') || query.includes('max-height')) {
      return {
        matches: isMobile,
        media: query,
        onchange: null,
        addListener: () => {},
        removeListener: () => {},
        addEventListener: () => {},
        removeEventListener: () => {},
        dispatchEvent: () => true,
      } as MediaQueryList
    }
    return originalMatchMedia(query)
  }
  return () => {
    window.matchMedia = originalMatchMedia
  }
}

function renderCard() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  return render(
    <QueryClientProvider client={client}>
      <WorkspaceInfoCard workspace="/work/project" />
    </QueryClientProvider>,
  )
}

function renderChatCard() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  return render(
    <QueryClientProvider client={client}>
      <WorkspaceInfoCard workspace="/Users/someone" chatWorkspace />
    </QueryClientProvider>,
  )
}

afterEach(() => {
  cleanup()
  requestCount = 0
  getCodingWorkspaceStatus.mockClear()
})

describe('WorkspaceInfoCard', () => {
  it('shows an explicit error with a working retry instead of a false non-git state', async () => {
    const user = userEvent.setup()
    renderCard()

    expect(await screen.findByText('Could not load workspace status')).toBeInTheDocument()
    expect(screen.queryByText('Not a git repository')).toBeNull()

    await user.click(screen.getByRole('button', { name: 'Retry workspace status' }))
    await waitFor(() => expect(screen.getByText('main')).toBeInTheDocument())
    expect(getCodingWorkspaceStatus).toHaveBeenCalledTimes(2)
  })

  it('renders a chat empty state without git status or the home path', () => {
    renderChatCard()

    expect(screen.getByRole('heading', { name: 'Chat' })).toBeInTheDocument()
    expect(screen.getByText(/runs here, in your home directory/i)).toBeInTheDocument()
    // No repository-shaped fallbacks leaking into the chat surface.
    expect(screen.queryByText('Not a git repository')).toBeNull()
    expect(screen.queryByText('/Users/someone')).toBeNull()
    expect(getCodingWorkspaceStatus).not.toHaveBeenCalled()
    expect(screen.queryByRole('button', { name: 'Ask about this repo' })).toBeNull()
  })

  it('offers starter actions on a coding empty state', async () => {
    const user = userEvent.setup()
    const onAsk = mock(() => {})
    const onInit = mock(() => {})
    const onOpenTerminal = mock(() => {})
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    })
    requestCount = 1
    render(
      <QueryClientProvider client={client}>
        <WorkspaceInfoCard
          workspace="/work/project"
          onAsk={onAsk}
          onInit={onInit}
          onOpenTerminal={onOpenTerminal}
        />
      </QueryClientProvider>,
    )

    await waitFor(() => expect(screen.getByText('main')).toBeInTheDocument())
    await user.click(screen.getByRole('button', { name: 'Ask about this repo' }))
    await user.click(screen.getByRole('button', { name: 'Generate AGENTS.md' }))
    await user.click(screen.getByRole('button', { name: 'Open terminal' }))
    expect(onAsk).toHaveBeenCalledTimes(1)
    expect(onInit).toHaveBeenCalledTimes(1)
    expect(onOpenTerminal).toHaveBeenCalledTimes(1)
  })

  it('drops the starter prompt suggestions on mobile', async () => {
    const restore = mockIsMobile(true)
    try {
      const client = new QueryClient({
        defaultOptions: { queries: { retry: false } },
      })
      requestCount = 1
      render(
        <QueryClientProvider client={client}>
          <WorkspaceInfoCard
            workspace="/work/project"
            onAsk={() => {}}
            onInit={() => {}}
            onOpenTerminal={() => {}}
          />
        </QueryClientProvider>,
      )

      // The workspace context itself still renders — only the chips go away.
      await waitFor(() => expect(screen.getByText('main')).toBeInTheDocument())
      expect(screen.queryByRole('button', { name: 'Ask about this repo' })).toBeNull()
      expect(screen.queryByRole('button', { name: 'Generate AGENTS.md' })).toBeNull()
      expect(screen.queryByRole('button', { name: 'Open terminal' })).toBeNull()
    } finally {
      restore()
    }
  })
})
