import type { ComponentProps } from 'react'
import { describe, expect, it, mock } from 'bun:test'
import { render, screen } from '@testing-library/react'
import '@testing-library/jest-dom'
import userEvent from '@testing-library/user-event'

import { AgentChatHeader } from '@/components/AgentChatView/AgentChatHeader'

function renderHeader(overrides: Partial<ComponentProps<typeof AgentChatHeader>> = {}) {
  const props: ComponentProps<typeof AgentChatHeader> = {
    dragHandlers: {},
    isMacOverlay: false,
    isMobile: true,
    workspace: '/Users/name/Workspace A',
    sessionTitle: 'Fix updater restart',
    onCodingSidebarToggle: () => undefined,
    headerTokens: undefined,
    sessionId: 'session-1',
    todos: [],
    showTodos: false,
    setShowTodos: () => undefined,
    codingPanel: null,
    onWorkspaceFiles: () => undefined,
    agentCapabilitiesOpen: false,
    onToggleAgentCapabilities: () => undefined,
    showMobileActions: false,
    setShowMobileActions: () => undefined,
    mobileActionsDragOffset: null,
    onToggleScheduler: () => undefined,
    onFindInTranscript: () => undefined,
    onOpenTerminal: () => undefined,
    onCloseMobileActionsMenu: () => undefined,
    ...overrides,
  }
  return render(<AgentChatHeader {...props} />)
}

describe('AgentChatHeader', () => {
  it('shows only the workspace title for mobile coding sessions', () => {
    renderHeader()

    expect(screen.getByText('Workspace A')).toBeInTheDocument()
    expect(screen.queryByText('Fix updater restart')).not.toBeInTheDocument()
  })

  it('keeps desktop coding sessions showing workspace and session title', () => {
    renderHeader({ isMobile: false })

    expect(screen.getByText('Workspace A')).toBeInTheDocument()
    expect(screen.getByText('Fix updater restart')).toBeInTheDocument()
  })

  it('renders token meter on mobile when headerTokens has zero usage', () => {
    renderHeader({
      isMobile: true,
      headerTokens: { input: 0, output: 0, cached: 0 },
    })

    expect(screen.getByRole('button', { name: /Input: 0/i })).toBeInTheDocument()
  })

  it('hides token meter when headerTokens is undefined', () => {
    renderHeader({ headerTokens: undefined })
    expect(screen.queryByRole('button', { name: /Input:/i })).not.toBeInTheDocument()
  })

  it('runs mobile transcript and terminal actions before closing the drawer', async () => {
    const user = userEvent.setup()
    const onFindInTranscript = mock(() => {})
    const onOpenTerminal = mock(() => {})
    const onCloseMobileActionsMenu = mock(() => {})
    renderHeader({
      showMobileActions: true,
      onFindInTranscript,
      onOpenTerminal,
      onCloseMobileActionsMenu,
    })

    await user.click(screen.getByRole('button', { name: 'Find in transcript' }))
    await user.click(screen.getByRole('button', { name: 'Open terminal' }))

    expect(onFindInTranscript).toHaveBeenCalledTimes(1)
    expect(onOpenTerminal).toHaveBeenCalledTimes(1)
    expect(onCloseMobileActionsMenu).toHaveBeenCalledTimes(2)
  })

  it('labels the chat workspace "Chat" instead of its home-directory basename', () => {
    renderHeader({
      isMobile: false,
      workspace: '/Users/name',
      chatWorkspace: { path: '/Users/name', name: 'Chat' },
      sessionTitle: null,
    })

    expect(screen.getByText('Chat')).toBeInTheDocument()
    expect(screen.queryByText('name')).not.toBeInTheDocument()
  })

  it('keeps revealing the real path when hovering a coding workspace', async () => {
    const user = userEvent.setup()
    renderHeader({ isMobile: false, sessionTitle: null })

    await user.hover(screen.getByText('Workspace A'))

    expect(screen.getByRole('tooltip')).toHaveTextContent('/Users/name/Workspace A')
  })

  it('never leaks the home path into the chat workspace tooltip', async () => {
    const user = userEvent.setup()
    renderHeader({
      isMobile: false,
      workspace: '/Users/name',
      chatWorkspace: { path: '/Users/name', name: 'Chat' },
      sessionTitle: null,
    })

    await user.hover(screen.getByText('Chat'))

    expect(screen.getByRole('tooltip')).toHaveTextContent('Chat')
    expect(screen.queryByText('/Users/name')).not.toBeInTheDocument()
  })
})
