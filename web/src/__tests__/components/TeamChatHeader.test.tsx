import type { ComponentProps, ReactNode } from 'react'
import { describe, expect, it, mock } from 'bun:test'
import { render, screen } from '@testing-library/react'
import '@testing-library/jest-dom'

mock.module('@tanstack/react-router', () => ({
  Link: ({ children }: { children: ReactNode }) => children,
}))

import { TeamChatHeader } from '@/components/TeamChatView/TeamChatHeader'
import type { ViewMode } from '@/components/TeamChatView/types'

function renderHeader(overrides: Partial<ComponentProps<typeof TeamChatHeader>> = {}) {
  const props: ComponentProps<typeof TeamChatHeader> = {
    dragHandlers: {},
    isMacOverlay: false,
    isMobile: true,
    workspace: '/Users/name/Workspace A',
    sessionTitle: 'Fix updater restart',
    activeAgent: null,
    effectiveViewMode: 'agent' as ViewMode,
    splitAgentCount: 1,
    navigate: (async () => undefined) as ComponentProps<typeof TeamChatHeader>['navigate'],
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
    agentNames: [],
    agentStreams: {},
    onSelectAgent: () => undefined,
    onToggleScheduler: () => undefined,
    onCloseMobileActionsMenu: () => undefined,
    viewMode: 'agent' as ViewMode,
    onViewModeChange: () => undefined,
    ...overrides,
  }
  return render(<TeamChatHeader {...props} />)
}

describe('TeamChatHeader', () => {
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
})
