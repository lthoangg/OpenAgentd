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
import React from 'react'
import { render, screen, cleanup } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import '@testing-library/jest-dom'

mock.module('lucide-react', () => new Proxy({}, { get: () => () => null }))

// Toggled per test. Default false so the edge-swipe tests below keep running
// in the normal-motion environment they were written for.
let reduceMotion = false
mock.module('@/hooks/useReducedMotion', () => ({ useReducedMotion: () => reduceMotion }))

// Prop-capturing framer stub — setup.ts's global stub strips the animation
// props these tests need to inspect. `data-*` still reaches the DOM so the
// edge-swipe assertions keep working.
const captured: Array<Record<string, unknown>> = []
const motionCache: Record<string, React.FC> = {}
mock.module('framer-motion', () => ({
  AnimatePresence: ({ children }: { children?: React.ReactNode }) => <>{children}</>,
  motion: new Proxy({}, {
    get: (_t, tag: string) => {
      if (!motionCache[tag]) {
        motionCache[tag] = ({ children, ...props }: { children?: React.ReactNode } & Record<string, unknown>) => {
          captured.push({ __tag: tag, ...props })
          const domProps: Record<string, unknown> = {}
          for (const [k, v] of Object.entries(props)) {
            if (k === 'className' || k === 'style' || k === 'role' || k.startsWith('data-') || k.startsWith('aria-')) {
              domProps[k] = v
            }
          }
          return React.createElement(tag, domProps, children)
        }
      }
      return motionCache[tag]
    },
  }),
}))

mock.module('@/components/settings/pages/settings.index', () => ({ SettingsHubPage: () => <div>hub</div> }))
mock.module('@/components/settings/pages/settings.agents', () => ({ AgentsListPage: () => <div>agents</div> }))
mock.module('@/components/settings/pages/settings.agents.new', () => ({ NewAgentPage: () => <div>new-agent</div> }))
mock.module('@/components/settings/pages/settings.agents.$name', () => ({ AgentEditorPage: () => <div>agent-edit</div> }))
mock.module('@/components/settings/pages/settings.skills', () => ({ SkillsListPage: () => <div>skills</div> }))
mock.module('@/components/settings/pages/settings.skills.new', () => ({ NewSkillPage: () => <div>new-skill</div> }))
mock.module('@/components/settings/pages/settings.skills.$name', () => ({ SkillEditorPage: () => <div>skill-edit</div> }))
mock.module('@/components/settings/pages/settings.mcp', () => ({ McpListPage: () => <div>mcp</div> }))
mock.module('@/components/settings/pages/settings.mcp.new', () => ({ NewMcpServerPage: () => <div>new-mcp</div> }))
mock.module('@/components/settings/pages/settings.mcp.$name', () => ({ McpServerDetailPage: () => <div>mcp-edit</div> }))
mock.module('@/components/settings/pages/settings.providers', () => ({ ProvidersSettingsPage: () => <div>providers</div> }))
mock.module('@/components/settings/pages/settings.denied_paths', () => ({ DeniedPathsSettingsPage: () => <div>denied-paths</div> }))
mock.module('@/components/settings/pages/settings.multimodal', () => ({ MultimodalSettingsPage: () => <div>multimodal</div> }))
mock.module('@/components/settings/pages/settings.summarization', () => ({ SummarizationSettingsPage: () => <div>summarization</div> }))
mock.module('@/components/settings/pages/settings.title-generation', () => ({ TitleGenerationSettingsPage: () => <div>title-gen</div> }))
mock.module('@/components/settings/pages/settings.notifications', () => ({ NotificationSettingsPage: () => <div>notifications</div> }))
mock.module('@/components/settings/pages/settings.terminal', () => ({ TerminalSettingsPage: () => <div>terminal</div> }))

import { SettingsModal } from '@/components/SettingsModal'
import { useSettingsStore } from '@/stores/useSettingsStore'

afterEach(() => {
  cleanup()
  useSettingsStore.setState({ open: false, section: 'about', selectedName: null })
  captured.length = 0
  reduceMotion = false
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

describe('SettingsModal — prefers-reduced-motion', () => {
  /** The panel is the motion element carrying the dialog role. */
  function findPanel() {
    return captured.find((p) => p.role === 'dialog')
  }

  it('scales and lifts the panel in by default', () => {
    useSettingsStore.setState({ open: true, section: 'about', selectedName: null })
    renderModal()

    expect(findPanel()!.initial).toEqual({ opacity: 0, scale: 0.98, y: 4 })
  })

  it('fades the panel in with no scale or translate when reduced motion is set', () => {
    reduceMotion = true
    useSettingsStore.setState({ open: true, section: 'about', selectedName: null })
    renderModal()

    const panel = findPanel()!
    expect(panel.initial).toEqual({ opacity: 0 })
    expect(panel.animate).toEqual({ opacity: 1 })
    expect(panel.exit).toEqual({ opacity: 0 })
    expect(panel.transition).toMatchObject({ duration: 0 })
  })
})
