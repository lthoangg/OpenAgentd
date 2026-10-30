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
import { act, fireEvent, render, screen, cleanup } from '@testing-library/react'
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

mock.module('@/components/settings/pages/settings.index', () => ({ AboutSettingsPage: () => <div>hub</div> }))
mock.module('@/components/settings/pages/settings.general', () => ({ GeneralSettingsPage: () => <div>general</div> }))
mock.module('@/components/settings/pages/settings.connection', () => ({ ConnectionSettingsPage: () => <div>connection</div> }))
mock.module('@/components/settings/pages/settings.agents', () => ({ AgentsListPage: () => <div>agents</div> }))
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

import { SettingsModal } from '@/components/SettingsModal'
import { useSettingsStore } from '@/stores/useSettingsStore'

afterEach(() => {
  cleanup()
  useSettingsStore.setState({ open: false, section: 'about', selectedName: null, mobileView: 'index', dirtyDrafts: {}, pendingNavigation: null })
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

  it('renders Close as a Button primitive so touch gets the same 44px target as Back', () => {
    useSettingsStore.setState({ open: true, section: 'about', selectedName: null })
    renderModal()

    expect(screen.getByRole('button', { name: 'Close settings' })).toHaveAttribute('data-slot', 'button')
  })

  it('falls back to About when an old removed section is restored from storage', () => {
    useSettingsStore.setState({
      open: true,
      section: 'terminal' as never,
      selectedName: null,
    })
    renderModal()

    expect(screen.getByRole('button', { name: 'About OpenAgentd' }).getAttribute('aria-current')).toBe('page')
  })
})

describe('SettingsModal — sections', () => {
  it('renders a section page on open, without a loading step, and switches sections in place', () => {
    useSettingsStore.setState({ open: true, section: 'providers', selectedName: null })
    renderModal()

    expect(screen.getByText('providers')).toBeTruthy()

    act(() => useSettingsStore.setState({ section: 'mcp' }))
    expect(screen.getByText('mcp')).toBeTruthy()
  })
})

describe('SettingsModal — phone navigation', () => {
  it('starts at the section list and opens a section from it', async () => {
    useSettingsStore.setState({ open: false, section: 'general', selectedName: null })
    act(() => useSettingsStore.getState().openSettings())
    renderModal()

    expect(screen.getByRole('navigation', { name: 'Settings sections' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Back to settings' })).toBeNull()

    act(() => useSettingsStore.getState().setSection('providers'))
    expect(screen.queryByRole('navigation', { name: 'Settings sections' })).toBeNull()
    expect(screen.getByText('providers')).toBeTruthy()
  })

  it('goes Back from a section to the list, and from an editor to its list', () => {
    useSettingsStore.setState({ open: false })
    act(() => useSettingsStore.getState().openSettings('skills-edit', 'review'))
    renderModal()

    act(() => screen.getByRole('button', { name: 'Back to list' }).click())
    expect(useSettingsStore.getState().section).toBe('skills')
    expect(useSettingsStore.getState().mobileView).toBe('section')

    act(() => screen.getByRole('button', { name: 'Back to settings' }).click())
    expect(useSettingsStore.getState().mobileView).toBe('index')
    expect(screen.getByRole('navigation', { name: 'Settings sections' })).toBeTruthy()
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

describe('SettingsModal — nav search and groups', () => {
  it('groups the nav in sentence case: App, Agents and tools, Sessions, Models and media, Data and safety', () => {
    useSettingsStore.setState({ open: true, section: 'about', selectedName: null })
    renderModal()

    const nav = screen.getByRole('navigation', { name: 'Settings categories' })
    const groups = [...nav.querySelectorAll('[role=group]')].map((g) => g.getAttribute('aria-label'))
    expect(groups).toEqual(['App', 'Agents and tools', 'Sessions', 'Models and media', 'Data and safety', 'About'])
    expect(screen.getByRole('button', { name: 'Session titles' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Denied paths' })).toBeTruthy()
  })

  it('filters sections by name or description, and Enter opens the first match', () => {
    useSettingsStore.setState({ open: true, section: 'about', selectedName: null })
    renderModal()

    const search = screen.getByRole('searchbox', { name: 'Search settings' })
    act(() => { fireEvent.change(search, { target: { value: 'api keys' } }) })
    expect(screen.getByRole('button', { name: 'Providers' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Memory' })).toBeNull()

    act(() => { fireEvent.keyDown(search, { key: 'Enter' }) })
    expect(useSettingsStore.getState().section).toBe('providers')
  })

  it('says when nothing matches', () => {
    useSettingsStore.setState({ open: true, section: 'about', selectedName: null })
    renderModal()

    act(() => { fireEvent.change(screen.getByRole('searchbox', { name: 'Search settings' }), { target: { value: 'zzz' } }) })
    expect(screen.getByText('No settings match “zzz”.')).toBeTruthy()
  })
})
