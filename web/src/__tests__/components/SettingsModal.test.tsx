/**
 * SettingsModal — mobile edge-swipe exclusion regression.
 *
 * SettingsModal is a hand-rolled full-screen overlay (not built on the
 * shared `AppOverlay` primitive), so it doesn't get `data-swipe-ignore`
 * for free. Without it, `useEdgeSwipe` (attached on the outer app shell)
 * would read a touch-drag on top of the open Settings modal as an
 * edge-swipe gesture for the sidebar/actions drawer underneath.
 *
 * Child route pages are stubbed — this test only cares about the modal
 * shell (backdrop + panel), not section content.
 */
import { describe, it, expect, afterEach, mock } from 'bun:test'
import { render, screen, cleanup } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import '@testing-library/jest-dom'

mock.module('lucide-react', () => new Proxy({}, { get: () => () => null }))

mock.module('@/routes/settings.index', () => ({ SettingsHubPage: () => <div>hub</div> }))
mock.module('@/routes/settings.agents', () => ({ AgentsListPage: () => <div>agents</div> }))
mock.module('@/routes/settings.agents.new', () => ({ NewAgentPage: () => <div>new-agent</div> }))
mock.module('@/routes/settings.agents.$name', () => ({ AgentEditorPage: () => <div>agent-edit</div> }))
mock.module('@/routes/settings.skills', () => ({ SkillsListPage: () => <div>skills</div> }))
mock.module('@/routes/settings.skills.new', () => ({ NewSkillPage: () => <div>new-skill</div> }))
mock.module('@/routes/settings.skills.$name', () => ({ SkillEditorPage: () => <div>skill-edit</div> }))
mock.module('@/routes/settings.mcp', () => ({ McpListPage: () => <div>mcp</div> }))
mock.module('@/routes/settings.mcp.new', () => ({ NewMcpServerPage: () => <div>new-mcp</div> }))
mock.module('@/routes/settings.mcp.$name', () => ({ McpServerDetailPage: () => <div>mcp-edit</div> }))
mock.module('@/routes/settings.providers', () => ({ ProvidersSettingsPage: () => <div>providers</div> }))
mock.module('@/routes/settings.sandbox', () => ({ SandboxSettingsPage: () => <div>sandbox</div> }))
mock.module('@/routes/settings.multimodal', () => ({ MultimodalSettingsPage: () => <div>multimodal</div> }))
mock.module('@/routes/settings.summarization', () => ({ SummarizationSettingsPage: () => <div>summarization</div> }))
mock.module('@/routes/settings.title-generation', () => ({ TitleGenerationSettingsPage: () => <div>title-gen</div> }))
mock.module('@/routes/settings.notifications', () => ({ NotificationSettingsPage: () => <div>notifications</div> }))
mock.module('@/routes/settings.terminal', () => ({ TerminalSettingsPage: () => <div>terminal</div> }))

import { SettingsModal } from '@/components/SettingsModal'
import { useSettingsStore } from '@/stores/useSettingsStore'

afterEach(() => {
  cleanup()
  useSettingsStore.setState({ open: false, section: 'about', selectedName: null })
})

function renderModal() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Number.POSITIVE_INFINITY } },
  })
  return render(
    <QueryClientProvider client={queryClient}>
      <SettingsModal />
    </QueryClientProvider>,
  )
}

describe('SettingsModal — mobile edge-swipe exclusion', () => {
  it('renders nothing when closed', () => {
    useSettingsStore.setState({ open: false })
    renderModal()
    expect(screen.queryByRole('dialog', { name: 'Settings' })).toBeNull()
  })

  it('marks both the backdrop and the panel data-swipe-ignore when open', () => {
    useSettingsStore.setState({ open: true, section: 'about', selectedName: null })
    renderModal()

    const panel = screen.getByRole('dialog', { name: 'Settings' })
    expect(panel).toHaveAttribute('data-swipe-ignore')

    const backdrop = document.querySelector('[aria-hidden="true"]')
    expect(backdrop).not.toBeNull()
    expect(backdrop).toHaveAttribute('data-swipe-ignore')
  })
})
