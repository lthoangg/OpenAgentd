/**
 * SettingsModal — the shell around the section pages: the shared AppOverlay
 * frame (wide, app-level), the unsaved-changes prompt, phone navigation, nav
 * search and groups.
 *
 * The panel and its backdrop carry `data-swipe-ignore` (from AppOverlay).
 * Without it, `useEdgeSwipe` (attached on the outer app shell) would read a
 * touch-drag on top of the open Settings modal as an edge-swipe gesture for
 * the sidebar/actions drawer underneath.
 *
 * Child route pages are stubbed — this test only cares about the modal
 * shell (backdrop + panel), not section content.
 */
import { describe, it, expect, afterEach, mock } from 'bun:test'
import React from 'react'
import { act, fireEvent, render, screen, cleanup, waitFor, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import '@testing-library/jest-dom'

mock.module('lucide-react', () => new Proxy({}, { get: () => () => null }))

// Toggled per test. Default false so the edge-swipe tests below keep running
// in the normal-motion environment they were written for.
let reduceMotion = false
mock.module('@/hooks/useReducedMotion', () => ({ useReducedMotion: () => reduceMotion }))

// A phone: the sheet's iOS bar and the list → section stack. Off by default.
let phone = false
mock.module('@/hooks/use-is-phone', () => ({ useIsPhone: () => phone }))

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
mock.module('@/components/settings/pages/settings.general', () => ({
  GeneralSettingsPage: () => <div>general<span>Text size</span><button role="radio" aria-checked="false">Compact</button></div>,
}))
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
  phone = false
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
    expect(screen.queryByRole('button', { name: 'Back to Settings' })).toBeNull()

    act(() => useSettingsStore.getState().setSection('providers'))
    expect(screen.queryByRole('navigation', { name: 'Settings sections' })).toBeNull()
    expect(screen.getByText('providers')).toBeTruthy()
  })

  it('goes Back from a section to the list, and from an editor to its list', () => {
    useSettingsStore.setState({ open: false })
    act(() => useSettingsStore.getState().openSettings('skills-edit', 'review'))
    renderModal()

    act(() => screen.getByRole('button', { name: 'Back to Skills' }).click())
    expect(useSettingsStore.getState().section).toBe('skills')
    expect(useSettingsStore.getState().mobileView).toBe('section')

    act(() => screen.getByRole('button', { name: 'Back to Settings' }).click())
    expect(useSettingsStore.getState().mobileView).toBe('index')
    expect(screen.getByRole('navigation', { name: 'Settings sections' })).toBeTruthy()
  })
})

describe('SettingsModal — one overlay frame', () => {
  it('is the shared AppOverlay card: wide, and mounted at the app level', () => {
    useSettingsStore.setState({ open: true, section: 'about', selectedName: null })
    renderModal()

    const panel = screen.getByRole('dialog', { name: 'Settings' })
    expect(panel.className).toContain('app-overlay-modal')
    expect(panel.className).not.toContain('settings-modal-shell')
    expect(panel.getAttribute('data-overlay-level')).toBe('app')
    expect(panel.style.getPropertyValue('--overlay-max-width')).toBe('76rem')
  })

  it('keeps the root the pages scope their shortcuts to inside the panel', () => {
    useSettingsStore.setState({ open: true, section: 'about', selectedName: null })
    renderModal()

    const root = document.querySelector('[data-settings-modal]')
    expect(root).not.toBeNull()
    expect(screen.getByRole('dialog', { name: 'Settings' }).contains(root)).toBe(true)
    expect(root?.contains(screen.getByRole('navigation', { name: 'Settings categories' }))).toBe(true)
  })

  it('asks "Discard changes?" before leaving unsaved settings: Cancel and Discard changes, no ×', () => {
    useSettingsStore.setState({ open: true, section: 'general', selectedName: null, dirtyDrafts: { general: true } })
    renderModal()

    act(() => useSettingsStore.getState().closeSettings())
    const prompt = screen.getByRole('dialog', { name: 'Discard changes?' })
    expect(useSettingsStore.getState().open).toBe(true)
    expect(within(prompt).queryByRole('button', { name: 'Close' })).toBeNull()
    expect(within(prompt).queryByRole('button', { name: 'Keep editing' })).toBeNull()

    act(() => within(prompt).getByRole('button', { name: 'Cancel' }).click())
    expect(useSettingsStore.getState().pendingNavigation).toBeNull()
    expect(useSettingsStore.getState().open).toBe(true)

    act(() => useSettingsStore.getState().closeSettings())
    act(() => within(screen.getByRole('dialog', { name: 'Discard changes?' })).getByRole('button', { name: 'Discard changes' }).click())
    expect(useSettingsStore.getState().open).toBe(false)
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

    // The shared overlay's motion: settles in from 96%, lifting 6px.
    expect(findPanel()!.initial).toEqual({ opacity: 0, scale: 0.96, y: 6 })
  })

  it('fades the panel in with no scale or translate when reduced motion is set', () => {
    reduceMotion = true
    useSettingsStore.setState({ open: true, section: 'about', selectedName: null })
    renderModal()

    const panel = findPanel()!
    expect(panel.initial).toEqual({ opacity: 0 })
    expect(panel.animate).toMatchObject({ opacity: 1, transition: { duration: 0 } })
    expect(panel.exit).toMatchObject({ opacity: 0, transition: { duration: 0 } })
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

  /** The sidebar's own search: the phone section list has one too, hidden by CSS from 768px up. */
  const sidebar = () => within(screen.getByRole('navigation', { name: 'Settings categories' }))
  // The modal focuses its start field on the next animation frame.
  const frame = () => act(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())))

  it('filters sections by name or description, and Enter opens the first match', () => {
    useSettingsStore.setState({ open: true, section: 'about', selectedName: null })
    renderModal()

    const search = sidebar().getByRole('searchbox', { name: 'Search settings' })
    act(() => { fireEvent.change(search, { target: { value: 'api keys' } }) })
    // The results list stands in for the section list while there is a query.
    const results = within(sidebar().getByRole('list', { name: 'Search results' }))
    expect(results.getByRole('button', { name: 'Providers' })).toBeTruthy()
    expect(results.queryByRole('button', { name: 'Memory' })).toBeNull()

    act(() => { fireEvent.keyDown(search, { key: 'Enter' }) })
    expect(useSettingsStore.getState().section).toBe('providers')
  })

  it('finds a single setting, not only a section, and opens the section that holds it', () => {
    useSettingsStore.setState({ open: true, section: 'about', selectedName: null })
    renderModal()

    act(() => { fireEvent.change(sidebar().getByRole('searchbox', { name: 'Search settings' }), { target: { value: 'fallback order' } }) })
    const result = sidebar().getByRole('button', { name: 'Accounts and fallback order, in Providers' })
    act(() => { fireEvent.click(result) })
    expect(useSettingsStore.getState().section).toBe('providers')
  })

  it('scrolls to the setting it opened and focuses its control', async () => {
    useSettingsStore.setState({ open: true, section: 'about', selectedName: null })
    renderModal()

    act(() => { fireEvent.change(sidebar().getByRole('searchbox', { name: 'Search settings' }), { target: { value: 'text size' } }) })
    act(() => { fireEvent.click(sidebar().getByRole('button', { name: 'Text size, in Appearance' })) })
    expect(useSettingsStore.getState().section).toBe('general')
    await waitFor(() => expect(document.activeElement?.textContent).toBe('Compact'))
  })

  it('opens with focus in its search field, as a Settings window does, not on Close', async () => {
    // Focus on Close drew its ring and opened its tooltip the moment ⌘,
    // opened Settings.
    useSettingsStore.setState({ open: true, section: 'about', selectedName: null })
    renderModal()

    await frame()
    expect(document.activeElement).toBe(sidebar().getByRole('searchbox', { name: 'Search settings' }))
  })

  it('opens with focus in the page where the icon rail hides the search field', async () => {
    const original = HTMLInputElement.prototype.getClientRects
    // Hidden below 900px: no boxes.
    HTMLInputElement.prototype.getClientRects = function () { return this.type === 'search' ? ([] as unknown as DOMRectList) : original.call(this) }
    try {
      useSettingsStore.setState({ open: true, section: 'about', selectedName: null })
      renderModal()
      await frame()
      expect(document.activeElement?.tagName).toBe('MAIN')
    } finally {
      HTMLInputElement.prototype.getClientRects = original
    }
  })

  it('says when nothing matches', () => {
    useSettingsStore.setState({ open: true, section: 'about', selectedName: null })
    renderModal()

    act(() => { fireEvent.change(sidebar().getByRole('searchbox', { name: 'Search settings' }), { target: { value: 'zzz' } }) })
    expect(sidebar().getByText('No settings match “zzz”.')).toBeTruthy()
  })
})

describe('SettingsModal — icon rail below 900px', () => {
  const sidebar = () => screen.getByRole('navigation', { name: 'Settings categories' })

  it('collapses the sidebar to icons below 900px and keeps each name for screen readers', () => {
    useSettingsStore.setState({ open: true, section: 'about', selectedName: null })
    renderModal()

    expect(sidebar().className).toContain('w-12')
    expect(sidebar().className).toContain('min-[900px]:w-60')
    const providers = within(sidebar()).getByRole('button', { name: 'Providers' })
    expect(providers.querySelector('span.max-\\[899px\\]\\:sr-only')?.textContent).toBe('Providers')
    // Group headings go with the labels; the groups stay named for assistive tech.
    expect(within(sidebar()).getAllByRole('group').length).toBeGreaterThan(3)
  })

  it('names a section in an app tooltip, with what it holds', async () => {
    useSettingsStore.setState({ open: true, section: 'about', selectedName: null })
    renderModal()

    const row = within(sidebar()).getByRole('button', { name: 'Providers' })
    expect(row.getAttribute('title')).toBeNull()
    fireEvent.mouseEnter(row.parentElement as HTMLElement)
    // The close button's own hint may be open too (it holds focus first).
    await waitFor(() => {
      const tips = [...document.querySelectorAll('[role="tooltip"]')].map((t) => t.textContent ?? '')
      expect(tips.some((t) => t.includes('Providers') && t.includes('API keys and model accounts'))).toBe(true)
    }, { timeout: 1500 })
  })

  it('keeps search reachable on the rail: an icon that opens it in a dialog', async () => {
    useSettingsStore.setState({ open: true, section: 'about', selectedName: null })
    renderModal()

    act(() => { fireEvent.click(within(sidebar()).getByRole('button', { name: 'Search settings' })) })
    const dialog = await screen.findByRole('dialog', { name: 'Search settings' })
    act(() => { fireEvent.change(within(dialog).getByRole('searchbox', { name: 'Search settings' }), { target: { value: 'dark' } }) })
    act(() => { fireEvent.click(within(dialog).getByRole('button', { name: 'Theme, in Appearance' })) })
    expect(useSettingsStore.getState().section).toBe('general')
    // A boolean, not the element: a failing `toBeNull` pretty-prints the whole DOM node.
    await waitFor(() => expect(document.querySelector('[data-slot="dialog-content"]') === null).toBe(true))
  })
})

describe('SettingsModal — one name for the server section', () => {
  it('calls Settings → Server by that name in the sidebar', () => {
    useSettingsStore.setState({ open: true, section: 'about', selectedName: null })
    renderModal()
    expect(within(screen.getByRole('navigation', { name: 'Settings categories' })).getByRole('button', { name: 'Server' })).toBeTruthy()
    expect(within(screen.getByRole('navigation', { name: 'Settings categories' })).queryByRole('button', { name: 'Connection' })).toBeNull()
  })

  it('calls the retention section Retention, not Data retention', () => {
    useSettingsStore.setState({ open: true, section: 'about', selectedName: null })
    renderModal()
    const nav = within(screen.getByRole('navigation', { name: 'Settings categories' }))
    expect(nav.getByRole('button', { name: 'Retention' })).toBeTruthy()
    expect(nav.queryByRole('button', { name: 'Data retention' })).toBeNull()
  })
})

describe('SettingsModal — on a phone', () => {
  it('closes with Done, the sheet\'s own word, instead of ×', () => {
    phone = true
    useSettingsStore.setState({ open: false })
    act(() => useSettingsStore.getState().openSettings())
    renderModal()

    expect(screen.queryByRole('button', { name: 'Close settings' })).toBeNull()
    act(() => screen.getByRole('button', { name: 'Done' }).click())
    expect(useSettingsStore.getState().open).toBe(false)
  })

  it('pushes a section over the list, which stays mounted under it', () => {
    phone = true
    useSettingsStore.setState({ open: false })
    act(() => useSettingsStore.getState().openSettings())
    renderModal()

    const stack = document.querySelector('[data-settings-modal] [data-phone-stack]')
    expect(stack).not.toBeNull()
    expect(document.querySelector('[data-phone-stack-page]')?.hasAttribute('inert')).toBe(true)

    act(() => useSettingsStore.getState().setSection('providers'))
    expect(document.querySelector('[data-phone-stack-page]')?.hasAttribute('inert')).toBe(false)
    expect(screen.getByRole('heading', { name: 'Providers' })).toBeTruthy()
    // The list is still there, under the section, for the pop.
    expect(screen.getByRole('navigation', { name: 'Settings sections', hidden: true })).toBeTruthy()
  })

  it('names the list it goes back to: ‹ Settings', () => {
    phone = true
    useSettingsStore.setState({ open: false })
    act(() => useSettingsStore.getState().openSettings())
    renderModal()
    act(() => useSettingsStore.getState().setSection('providers'))

    const back = screen.getByRole('button', { name: 'Back to Settings' })
    expect(back.textContent).toBe('')
    act(() => back.click())
    expect(useSettingsStore.getState().mobileView).toBe('index')
  })

  it('climbs back to the list on Escape (Android Back) before it closes', () => {
    phone = true
    useSettingsStore.setState({ open: false })
    act(() => useSettingsStore.getState().openSettings())
    renderModal()
    act(() => useSettingsStore.getState().setSection('providers'))

    act(() => { fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' }) })
    expect(useSettingsStore.getState().open).toBe(true)
    expect(useSettingsStore.getState().mobileView).toBe('index')

    act(() => { fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' }) })
    expect(useSettingsStore.getState().open).toBe(false)
  })
})
