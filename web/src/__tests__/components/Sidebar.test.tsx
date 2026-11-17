import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { useToastStore } from '@/stores/useToastStore'
import { useUnreadStore } from '@/stores/useUnreadStore'
import {
  cleanupSidebarHarness,
  deleteSessionMutate,
  fx,
  invokeMock,
  navigate,
  renderSidebarForSessions,
  renderSidebarWithProps,
  resetSidebarHarness,
  setSessionPinnedMutate,
  workspaceTreeResponse,
  type TestSession,
} from './Sidebar/harness'

describe('Sidebar workspace trust flow', () => {
  beforeEach(resetSidebarHarness)
  afterEach(cleanupSidebarHarness)

  it('does not render a search bar on desktop', async () => {
    fx.isMobile = false

    await renderSidebarWithProps({})

    expect(screen.queryByRole('button', { name: 'Open Quick Open' })).toBeNull()
  })

  it('covers the content as a drawer in a narrow window, closing on a click outside', async () => {
    const onCollapse = mock(() => {})
    const view = await renderSidebarWithProps({ desktopCollapsed: false, drawer: true, onCollapse })
    const sidebar = view.container.querySelector('aside') as HTMLElement
    expect(sidebar.className).toContain('absolute')
    expect(sidebar.className).toContain('shadow-(--shadow-depth)')
    // It takes no room: the Review panel beside the chat keeps its width.
    expect(sidebar.hasAttribute('data-panel-target-width')).toBe(false)
    // The scrim sits over the Review panel, even one covering the chat (z-20),
    // so a click there closes the drawer instead of reaching the panel.
    const scrim = view.container.querySelector('[data-sidebar-drawer-backdrop]') as HTMLElement
    expect(scrim.className.split(' ')).toContain('z-25')
    fireEvent.pointerDown(scrim)
    expect(onCollapse).toHaveBeenCalledTimes(1)
  })

  it('keeps a collapsed sidebar out of Tab order', async () => {
    const collapsed = await renderSidebarWithProps({ desktopCollapsed: true })
    expect(collapsed.container.querySelector('aside')?.hasAttribute('inert')).toBe(true)
    collapsed.unmount()
    const open = await renderSidebarWithProps({ desktopCollapsed: false })
    expect(open.container.querySelector('aside')?.hasAttribute('inert')).toBe(false)
  })

  it('leaves no 1px edge down the window side once collapsed', async () => {
    // Collapsed to 0 wide, its right border still drew a hairline at x=0.
    const collapsed = await renderSidebarWithProps({ desktopCollapsed: true })
    expect(collapsed.container.querySelector('aside')?.className.split(' ')).toContain('border-r-0')
    collapsed.unmount()
    const open = await renderSidebarWithProps({ desktopCollapsed: false })
    expect(open.container.querySelector('aside')?.className.split(' ')).not.toContain('border-r-0')
  })

  it('renders a backdrop when the mobile coding sidebar is open', async () => {
    fx.isMobile = true

    const view = await renderSidebarWithProps({ mobileOpen: true })
    const backdrop = view.container.querySelector('[aria-hidden="true"]')

    expect(backdrop).toBeTruthy()
  })

  it('shows the drawer backdrop on a landscape phone wider than md', async () => {
    fx.isMobile = true

    const view = await renderSidebarWithProps({ mobileOpen: true })
    const backdrop = view.container.querySelector('.bg-\\(--color-overlay\\)')

    expect(backdrop?.className.split(' ')).not.toContain('md:hidden')
  })

  it('keeps the mobile drawer content clear of a left cutout in landscape', async () => {
    fx.isMobile = true

    const view = await renderSidebarWithProps({ mobileOpen: false })
    const drawer = view.container.querySelector('aside')

    // Fixed to the left edge, the drawer is outside the shell's safe-area
    // padding, so it pads its own content past the cutout.
    expect(drawer?.className.split(' ')).toContain('pl-safe')
    // Same width and closed offset, so the closed drawer stays off screen:
    // 280px out (past its shadow), the scrim clear and taking no touches.
    expect(JSON.parse(drawer?.getAttribute('data-animate') ?? '{}')).toEqual({
      width: 'min(272px, calc(100vw - 2rem))',
    })
    expect(drawer?.style.translate).toBe('-280px 0')
    const scrim = view.container.querySelector<HTMLElement>('[data-edge-drawer-scrim="sidebar"]')
    expect(scrim?.style.opacity).toBe('0')
    expect(scrim?.className.split(' ')).toContain('pointer-events-none')
  })

  it('leaves the desktop sidebar to the shell safe-area padding', async () => {
    const view = await renderSidebarWithProps({})

    expect(view.container.querySelector('aside')?.className.split(' ')).not.toContain('pl-safe')
  })

  describe('getting around', () => {
    const twoWorkspaces = () => {
      fx.sessionsData = [
        { id: 'session-1', title: 'Feature', agent_name: 'lead', created_at: '2026-05-13T00:00:00Z', updated_at: '2026-05-13T00:00:00Z', mode: 'coding', workspace: '/repo/project' },
        { id: 'session-2', title: 'Other work', agent_name: 'lead', created_at: '2026-05-12T00:00:00Z', updated_at: '2026-05-12T00:00:00Z', mode: 'coding', workspace: '/repo/other' },
      ]
      fx.workspaceSessionsData = fx.sessionsData
    }

    it('starts a new session from the New session row the way ⌘N does', async () => {
      twoWorkspaces()
      const onNewSession = mock(() => {})
      await renderSidebarWithProps({ currentSessionId: 'session-1', workspace: '/repo/project', onNewSession })

      const row = screen.getByRole('button', { name: 'New session' })
      expect(row.getAttribute('aria-keyshortcuts')).toBe('Meta+N')
      fireEvent.click(row)
      expect(onNewSession).toHaveBeenCalledTimes(1)
      expect(navigate).not.toHaveBeenCalled()
    })

    it('opens a draft in the current workspace when the chat has no handler', async () => {
      twoWorkspaces()
      await renderSidebarWithProps({ currentSessionId: 'session-1', workspace: '/repo/project' })

      fireEvent.click(screen.getByRole('button', { name: 'New session' }))
      expect(navigate).toHaveBeenCalledWith({ to: '/', search: { workspace: '/repo/project' }, replace: false })
    })

    it('opens a workspace’s latest session from its name, and folds only from the chevron', async () => {
      twoWorkspaces()
      await renderSidebarForSessions('session-1')

      fireEvent.click(screen.getByRole('button', { name: 'Open workspace other' }))
      await waitFor(() => expect(navigate).toHaveBeenCalledWith({ to: '/$sessionId', params: { sessionId: 'session-2' } }))

      // The workspace on screen has nothing to open: its name never folds it.
      navigate.mockClear()
      fireEvent.click(screen.getByRole('button', { name: 'Open workspace project' }))
      expect(navigate).not.toHaveBeenCalled()
      expect(screen.getByRole('button', { name: 'Collapse workspace project' })).toBeTruthy()

      fireEvent.click(screen.getByRole('button', { name: 'Collapse workspace project' }))
      expect(screen.getByRole('button', { name: 'Expand workspace project' }).getAttribute('aria-expanded')).toBe('false')
    })

    it('opens a draft from a workspace name when the workspace has no sessions', async () => {
      twoWorkspaces()
      fx.worktreesByRepo = {}
      // Only the tree knows /repo/empty; no list has a session there.
      const baseFetch = globalThis.fetch
      globalThis.fetch = mock(async (input: unknown, init?: unknown) => {
        const url = String(input)
        if (url.includes('/api/agent/workspace/tree')) {
          const tree = workspaceTreeResponse()
          return new Response(JSON.stringify({ ...tree, repositories: [...tree.repositories, { path: '/repo/empty', name: 'empty', worktrees: [], group_ids: [] }] }))
        }
        if (url.includes('/api/agent/sessions?')) return new Response(JSON.stringify({ data: [], has_more: false, next_cursor: null }))
        return baseFetch(input as RequestInfo, init as RequestInit | undefined)
      }) as typeof fetch
      await renderSidebarForSessions('session-1')

      fireEvent.click(await screen.findByRole('button', { name: 'Open workspace empty' }))
      await waitFor(() => expect(navigate).toHaveBeenCalledWith({ to: '/', search: { workspace: '/repo/empty' }, replace: false }))
    })

    it('says so, with Retry, when a workspace’s sessions could not load, instead of opening a blank draft', async () => {
      twoWorkspaces()
      fx.worktreesByRepo = {}
      useToastStore.setState({ toasts: [] })
      let failList = true
      const baseFetch = globalThis.fetch
      globalThis.fetch = mock(async (input: unknown, init?: unknown) => {
        const url = String(input)
        if (url.includes('/api/agent/workspace/tree')) {
          const tree = workspaceTreeResponse()
          return new Response(JSON.stringify({ ...tree, repositories: [...tree.repositories, { path: '/repo/empty', name: 'empty', worktrees: [], group_ids: [] }] }))
        }
        if (url.includes('/api/agent/sessions?') && url.includes('empty')) {
          if (failList) return new Response(JSON.stringify({ detail: 'boom' }), { status: 500 })
          return new Response(JSON.stringify({ data: [], has_more: false, next_cursor: null }))
        }
        return baseFetch(input as RequestInfo, init as RequestInit | undefined)
      }) as typeof fetch
      await renderSidebarForSessions('session-1')

      fireEvent.click(await screen.findByRole('button', { name: 'Open workspace empty' }))
      await waitFor(() => expect(useToastStore.getState().toasts.map((t) => t.title)).toEqual(["Couldn't open the last session"]))
      expect(navigate).not.toHaveBeenCalled()

      failList = false
      act(() => { useToastStore.getState().toasts[0].action?.onAction() })
      await waitFor(() => expect(navigate).toHaveBeenCalledWith({ to: '/', search: { workspace: '/repo/empty' }, replace: false }))
    })

    it('shows placeholders while the tree loads and Retry when it fails, never "No workspaces yet"', async () => {
      let treeRequests = 0
      let failTree = true
      const baseFetch = globalThis.fetch
      let releaseTree: () => void = () => {}
      const treeGate = new Promise<void>((resolve) => { releaseTree = resolve })
      globalThis.fetch = mock(async (input: unknown, init?: unknown) => {
        if (String(input).includes('/api/agent/workspace/tree')) {
          treeRequests += 1
          await treeGate
          if (failTree) return new Response(JSON.stringify({ detail: 'boom' }), { status: 500 })
          return new Response(JSON.stringify({ repositories: [{ path: '/repo/project', name: 'project', worktrees: [], group_ids: [] }], chat: null, groups: [] }))
        }
        return baseFetch(input as RequestInfo, init as RequestInit | undefined)
      }) as typeof fetch
      const { Sidebar } = await import('@/components/Sidebar')
      // No automatic retries, so the failure shows at once.
      const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
      render(
        <QueryClientProvider client={queryClient}>
          <Sidebar workspace={null} />
        </QueryClientProvider>,
      )

      expect(screen.getByRole('status', { name: 'Loading workspaces' })).toBeTruthy()
      expect(screen.queryByText('No workspaces yet')).toBeNull()

      await act(async () => { releaseTree() })
      const retry = await screen.findByRole('button', { name: 'Retry' })
      // "Couldn't load X." with a straight apostrophe, in the compact error state.
      expect(screen.getByText("Couldn't load workspaces.")).toBeTruthy()
      expect(screen.getByRole('alert').querySelector('[data-empty-state="compact"]')).toBeTruthy()
      expect(screen.queryByText('No workspaces yet')).toBeNull()

      failTree = false
      fireEvent.click(retry)
      expect(await screen.findByRole('button', { name: 'Open workspace project' })).toBeTruthy()
      expect(treeRequests).toBe(2)
    })

    it('says "No workspaces yet" as an empty state with the way to add one, once the tree loaded empty', async () => {
      const baseFetch = globalThis.fetch
      globalThis.fetch = mock(async (input: unknown, init?: unknown) => {
        if (String(input).includes('/api/agent/workspace/tree')) {
          return new Response(JSON.stringify({ repositories: [], chat: null, groups: [] }))
        }
        return baseFetch(input as RequestInfo, init as RequestInit | undefined)
      }) as typeof fetch
      const { Sidebar } = await import('@/components/Sidebar')
      const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
      render(
        <QueryClientProvider client={queryClient}>
          <Sidebar workspace={null} />
        </QueryClientProvider>,
      )

      const title = await screen.findByText('No workspaces yet')
      // Sentence case, no trailing period, in the compact (row-scale) form.
      expect(title.closest('[data-empty-state="compact"]')).toBeTruthy()
      const empty = title.closest('[data-empty-state="compact"]') as HTMLElement
      expect(within(empty).getByRole('button', { name: 'Open workspace…' })).toBeTruthy()
      // The word is explained once, where a newcomer first meets it.
      expect(empty.textContent).toContain('A workspace is a folder the agent works in.')
    })

    it('scrolls the session list and pins Scheduled below it with its own scroll', async () => {
      twoWorkspaces()
      const baseFetch = globalThis.fetch
      globalThis.fetch = mock(async (input: unknown, init?: unknown) => {
        if (String(input).includes('/api/scheduler/tasks')) {
          return new Response(JSON.stringify({ tasks: [{
            id: 'weekly', slug: 'weekly', name: 'Weekly report', workspace: '/repo/project', schedule_type: 'every', at_datetime: null, every_seconds: 3600,
            cron_expression: null, timezone: 'UTC', prompt: 'p', session_id: null, max_runs: null, enabled: false,
            status: 'paused', run_count: 0, last_run_at: null, last_error: null, next_fire_at: null,
            created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z',
          }] }))
        }
        return baseFetch(input as RequestInfo, init as RequestInit | undefined)
      }) as typeof fetch
      fx.pinnedSessionsData = [{ id: 'pinned-1', title: 'Pinned review', agent_name: 'lead', created_at: '2026-05-13T00:00:00Z', updated_at: '2026-05-13T00:00:00Z', mode: 'coding', workspace: '/repo/project', pinned_at: '2026-05-14T00:00:00Z' }]
      const view = await renderSidebarForSessions('session-1')

      const scroller = view!.container.querySelector('[data-sidebar-scroller]') as HTMLElement
      expect(scroller.className).toContain('overflow-y-auto')
      expect(scroller.contains(screen.getByRole('region', { name: 'Pinned' }))).toBe(true)
      expect(scroller.contains(screen.getByRole('button', { name: 'New session' }))).toBe(false)
      // The sticky section header stays inside the session scroller.
      const stickyHeader = scroller.querySelector('.sticky') as HTMLElement
      expect(stickyHeader).toBeTruthy()
      expect(stickyHeader.className).toContain('top-0')
      // Scheduled sits after it, outside, in its own capped scroller.
      const scheduled = await screen.findByRole('region', { name: 'Scheduled' })
      expect(scroller.contains(scheduled)).toBe(false)
      const scheduledScroller = view!.container.querySelector('[data-sidebar-scheduled-scroller]') as HTMLElement
      expect(scheduledScroller.contains(scheduled)).toBe(true)
      expect(scheduledScroller.className).toContain('max-h-56')
      expect(scheduledScroller.className).toContain('overflow-y-auto')
      expect(scroller.compareDocumentPosition(scheduledScroller) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
      expect(scheduledScroller.parentElement).toBe(scroller.parentElement)
      expect(Array.from(view!.container.querySelectorAll('.overflow-y-auto'))).toEqual([scroller, scheduledScroller])
      // Touch keeps the pin mark, though it drops the rest of the row meta for ⋯.
      const pinMark = view!.container.querySelector('[data-pin-mark]') as HTMLElement
      expect(pinMark.className).not.toContain('pointer-coarse:hidden')
    })
  })

  it('keeps the sidebar on the page tone in light mode and the rail in dark', async () => {
    const view = await renderSidebarForSessions(undefined)
    const aside = view?.container.querySelector('aside') as HTMLElement
    expect(aside.className).toContain('bg-(--bg-page)')
    expect(aside.className).toContain('dark:bg-(--bg-sidebar)')
    expect(aside.className.split(' ')).not.toContain('bg-(--bg-sidebar)')
  })

  it('marks a session that finished while you were elsewhere as unread', async () => {
    fx.sessionsData = [
      {
        id: 'session-1',
        title: 'Current session',
        agent_name: 'lead',
        created_at: '2026-05-13T00:00:00Z',
        updated_at: '2026-05-13T00:00:00Z',
        mode: 'coding',
        workspace: '/repo/project',
      },
      {
        id: 'session-2',
        title: 'Finished elsewhere',
        agent_name: 'lead',
        created_at: '2026-05-12T00:00:00Z',
        updated_at: '2026-05-12T00:00:00Z',
        mode: 'coding',
        workspace: '/repo/project',
      },
    ]
    fx.workspaceSessionsData = fx.sessionsData
    useUnreadStore.setState({ ids: ['session-2'] })

    await renderSidebarForSessions('session-1')

    expect(screen.getAllByLabelText('Unread session')).toHaveLength(1)
    expect(screen.getByText('Finished elsewhere').closest('button')?.querySelector('[aria-label="Unread session"]')).toBeTruthy()
  })

  it('shows a waiting or running state instead of the unread mark', async () => {
    fx.sessionsData = [
      {
        id: 'session-1',
        title: 'Waiting session',
        agent_name: 'lead',
        created_at: '2026-05-13T00:00:00Z',
        updated_at: '2026-05-13T00:00:00Z',
        mode: 'coding',
        workspace: '/repo/project',
        running: true,
        needs_input: true,
      },
      {
        id: 'session-2',
        title: 'Running session',
        agent_name: 'lead',
        created_at: '2026-05-12T00:00:00Z',
        updated_at: '2026-05-12T00:00:00Z',
        mode: 'coding',
        workspace: '/repo/project',
        running: true,
      },
    ]
    fx.workspaceSessionsData = fx.sessionsData
    useUnreadStore.setState({ ids: ['session-1', 'session-2'] })

    await renderSidebarForSessions(undefined)

    expect(screen.getByLabelText('Session needs your input')).toBeTruthy()
    expect(screen.getByLabelText('Session running')).toBeTruthy()
    expect(screen.queryByLabelText('Unread session')).toBeNull()
  })

  describe('sections and view options', () => {
    const projectSession = (id: string, title: string, extra: Partial<TestSession> = {}): TestSession => ({
      id,
      title,
      agent_name: 'lead',
      created_at: '2026-05-13T00:00:00Z',
      updated_at: '2026-05-13T00:00:00Z',
      mode: 'coding',
      workspace: '/repo/project',
      ...extra,
    })

    beforeEach(async () => {
      const { useSidebarViewStore } = await import('@/stores/useSidebarViewStore')
      useSidebarViewStore.setState({ groupBy: 'project', showDetails: true, pinnedCollapsed: false, collapsedGroups: [] })
    })

    it('has New session only atop the sidebar in Project mode, and keeps Collapse all in View options', async () => {
      fx.sessionsData = [projectSession('session-1', 'Feature')]
      fx.workspaceSessionsData = fx.sessionsData
      await renderSidebarForSessions('session-1')

      // One entry per place: the row atop the sidebar, not the section header.
      expect(screen.getAllByRole('button', { name: 'New session' }).map((el) => el.hasAttribute('data-sidebar-new-session'))).toEqual([true])
      fireEvent.click(screen.getByRole('button', { name: 'View options' }))
      expect(screen.getByRole('menuitem', { name: 'Collapse all workspaces' })).toBeTruthy()
      expect(fx.allSessionsQueryArgs).toEqual([])
    })

    it('switches to a flat list in Status mode', async () => {
      const { useSidebarViewStore } = await import('@/stores/useSidebarViewStore')
      useSidebarViewStore.setState({ groupBy: 'status' })
      fx.sessionsData = [projectSession('session-1', 'Feature')]
      fx.workspaceSessionsData = fx.sessionsData
      fx.allSessionsData = [projectSession('session-2', 'Flat row')]

      await renderSidebarForSessions('session-1')

      expect(screen.getByText('Flat row')).toBeTruthy()
      expect(fx.allSessionsQueryArgs.length).toBeGreaterThan(0)
      // The tree's controls belong to Project mode.
      expect(screen.queryByRole('menuitem', { name: 'Collapse all workspaces' })).toBeNull()
    })

    it('shows icon-only Settings, Usage and theme, plus the named server, in the mobile drawer footer', async () => {
      fx.isMobile = true
      fx.platformOs = 'ios'
      fx.sessionsData = [projectSession('session-1', 'Feature')]
      fx.workspaceSessionsData = fx.sessionsData

      await renderSidebarWithProps({ currentSessionId: 'session-1', workspace: '/repo/project', mobileOpen: true })

      expect(screen.getAllByRole('button', { name: 'New session' }).map((el) => el.hasAttribute('data-sidebar-new-session'))).toEqual([true])
      for (const name of ['Settings', 'Usage', /^Theme:/]) {
        const button = screen.getByRole('button', { name })
        expect(button.textContent).toBe('')
      }
      expect(screen.getByRole('button', { name: /Change computer$/ }).textContent).toBe('backend-name')
    })

    it('opens the command palette from the mobile drawer footer, closing the drawer first', async () => {
      fx.isMobile = true
      fx.sessionsData = [projectSession('session-1', 'Feature')]
      fx.workspaceSessionsData = fx.sessionsData
      const calls: string[] = []

      await renderSidebarWithProps({
        currentSessionId: 'session-1',
        workspace: '/repo/project',
        mobileOpen: true,
        onMobileClose: () => calls.push('close'),
        onOpenPalette: () => calls.push('palette'),
      })

      const button = screen.getByRole('button', { name: 'Command palette' })
      expect(button.textContent).toBe('')
      fireEvent.click(button)
      expect(calls).toEqual(['close', 'palette'])
    })

    it('opens the titled action sheet from a session row More button in a phone browser', async () => {
      fx.isMobile = true
      fx.sessionsData = [projectSession('session-1', 'A session title far too long for a phone row')]
      fx.workspaceSessionsData = fx.sessionsData

      await renderSidebarWithProps({ currentSessionId: 'session-1', workspace: '/repo/project', mobileOpen: true })

      fireEvent.click(screen.getByRole('button', { name: 'More actions for A session title far too long for a phone row' }))
      // The sheet names the session in full (tooltips never show on touch).
      expect(screen.getByText('Choose a session action.')).toBeTruthy()
      expect(screen.getAllByText('A session title far too long for a phone row').length).toBeGreaterThan(1)
      expect(screen.queryByRole('menu')).toBeNull()
      // A bottom sheet, as the phone's own long-press menus are, not a
      // centred dialog whose footer lays the actions out as a button row.
      const sheet = screen.getByRole('dialog', { name: 'A session title far too long for a phone row' })
      expect(sheet.hasAttribute('data-bottom-sheet')).toBe(true)
      // Delete reads as destructive at rest, as the desktop menu's does.
      expect(within(sheet).getByRole('button', { name: 'Delete session' }).className).toContain('text-(--color-error)')
    })

    it("opens a session's actions as a bottom sheet in the Android app", async () => {
      fx.isMobile = true
      fx.isTauri = true
      fx.platformOs = 'android'
      fx.sessionsData = [projectSession('session-1', 'Feature')]
      fx.workspaceSessionsData = fx.sessionsData

      await renderSidebarWithProps({ currentSessionId: 'session-1', workspace: '/repo/project', mobileOpen: true })
      fireEvent.click(screen.getByRole('button', { name: 'More actions for Feature' }))

      const sheet = screen.getByRole('dialog', { name: 'Feature' })
      expect(sheet.hasAttribute('data-bottom-sheet')).toBe(true)
      fireEvent.click(within(sheet).getByRole('button', { name: 'Rename' }))
      await waitFor(() => expect(screen.getByRole('textbox', { name: 'Session title' })).toBeTruthy())
      const calls = invokeMock.mock.calls as unknown as Array<[string]>
      expect(calls.some(([command]) => command === 'pick_one')).toBe(false)
    })

    it("opens a session's actions as the app's own bottom sheet in the iPhone app too", async () => {
      fx.isMobile = true
      fx.isTauri = true
      fx.platformOs = 'ios'
      fx.sessionsData = [projectSession('session-1', 'Feature')]
      fx.workspaceSessionsData = fx.sessionsData

      await renderSidebarWithProps({ currentSessionId: 'session-1', workspace: '/repo/project', mobileOpen: true })
      fireEvent.click(screen.getByRole('button', { name: 'More actions for Feature' }))

      const sheet = screen.getByRole('dialog', { name: 'Feature' })
      expect(sheet.hasAttribute('data-bottom-sheet')).toBe(true)
      fireEvent.click(within(sheet).getByRole('button', { name: 'Rename' }))
      await waitFor(() => expect(screen.getByRole('textbox', { name: 'Session title' })).toBeTruthy())
      const calls = invokeMock.mock.calls as unknown as Array<[string]>
      expect(calls.some(([command]) => command === 'pick_one')).toBe(false)
    })

    it('lists pinned sessions above the tree and unpins from the row menu', async () => {
      fx.pinnedSessionsData = [projectSession('pinned-1', 'Pinned review', { pinned_at: '2026-10-18T00:00:00Z' })]
      fx.sessionsData = [projectSession('session-1', 'Feature')]
      fx.workspaceSessionsData = fx.sessionsData

      await renderSidebarForSessions('session-1')

      // The row names its workspace and that it is pinned.
      const pinnedRow = screen.getByRole('button', { name: /^Pinned review.*pinned$/ })
      fireEvent.contextMenu(pinnedRow)
      fireEvent.click(await screen.findByRole('menuitem', { name: 'Unpin' }))
      expect(setSessionPinnedMutate).toHaveBeenCalledWith(
        { id: 'pinned-1', pinned: false },
        expect.anything(),
      )
    })

    it('lists the session actions in one order and pins from the context menu', async () => {
      fx.isTauri = true
      fx.platformOs = 'macos'
      fx.sessionsData = [projectSession('session-1', 'Feature')]
      fx.workspaceSessionsData = fx.sessionsData

      await renderSidebarForSessions('session-1')

      fireEvent.contextMenu(screen.getByRole('button', { name: /^Feature/ }))
      const items = within(await screen.findByRole('menu')).getAllByRole('menuitem')
      // No Share… and no Copy link: a session is opened from the app, not passed around.
      expect(items.map((item) => item.textContent)).toEqual([
        'Open in new window',
        'Rename',
        'Pin',
        'Delete session',
      ])
      fireEvent.click(within(screen.getByRole('menu')).getByRole('menuitem', { name: 'Pin' }))
      expect(setSessionPinnedMutate).toHaveBeenCalledWith(
        { id: 'session-1', pinned: true },
        expect.anything(),
      )
    })

    describe.each([
      { os: 'macos', deleteKey: { key: 'Backspace', metaKey: true } },
      { os: 'windows', deleteKey: { key: 'Backspace', ctrlKey: true } },
      { os: 'linux', deleteKey: { key: 'Delete' } },
    ])('session menu on $os', ({ os, deleteKey }) => {
      const openMenu = async () => {
        fx.isTauri = false
        fx.platformOs = os
        fx.sessionsData = [projectSession('session-1', 'Feature')]
        fx.workspaceSessionsData = fx.sessionsData
        await renderSidebarForSessions('session-1')
        const row = screen.getByRole('button', { name: /^Feature/ })
        fireEvent.contextMenu(row)
        return { row, menu: await screen.findByRole('menu') }
      }

      it('shows no key hints beside any action', async () => {
        const { menu } = await openMenu()

        for (const name of ['Rename', 'Pin', 'Delete session']) {
          const item = within(menu).getByRole('menuitem', { name })
          expect(item.querySelector('kbd')).toBeNull()
          expect(item.hasAttribute('aria-keyshortcuts')).toBe(false)
        }
        expect(menu.textContent).not.toContain('F2')
        expect(menu.textContent).not.toContain('⌘⌫')
      })

      it('neither renames nor deletes from the keyboard', async () => {
        const { row, menu } = await openMenu()
        fireEvent.keyDown(menu, { key: 'Escape' })

        fireEvent.keyDown(row, { key: 'F2' })
        expect(screen.queryByRole('textbox', { name: 'Session title' })).toBeNull()
        fireEvent.keyDown(screen.getByRole('button', { name: /^Feature/ }), deleteKey)
        expect(deleteSessionMutate).not.toHaveBeenCalled()
      })
    })

    it('shows no key hints in the phone sheet, which has no keyboard to press them on', async () => {
      fx.isMobile = true
      fx.sessionsData = [projectSession('session-1', 'Feature')]
      fx.workspaceSessionsData = fx.sessionsData

      await renderSidebarWithProps({ currentSessionId: 'session-1', workspace: '/repo/project', mobileOpen: true })
      fireEvent.click(screen.getByRole('button', { name: 'More actions for Feature' }))

      const sheet = screen.getByRole('dialog', { name: 'Feature' })
      expect(sheet.querySelector('kbd')).toBeNull()
      expect(within(sheet).getByRole('button', { name: 'Rename' }).textContent).toBe('Rename')
    })

    it('lists only what the workspace can do: no worktree for a folder without Git, no Groups block before a group exists', async () => {
      fx.sessionsData = [
        projectSession('session-1', 'Notes', { workspace: '/docs/notes' }),
        projectSession('session-2', 'Feature'),
      ]
      fx.workspaceSessionsData = fx.sessionsData
      fx.plainFolders = new Set(['/docs/notes'])

      await renderSidebarForSessions('session-1')
      const rows = (menu: HTMLElement) => Array.from(menu.children).map((el) => (el.getAttribute('role') === 'separator' ? '|' : el.textContent?.replace(/⌘N$/, '')))

      fireEvent.click(await screen.findByLabelText('Actions for notes'))
      let menu = screen.getByRole('menu', { name: 'Actions for notes' })
      expect(rows(menu)).toEqual(['New session', '|', 'Copy path', '|', 'Hide from sidebar'])
      fireEvent.keyDown(menu, { key: 'Escape' })

      // A repository keeps its worktree entry; still no Groups block.
      fireEvent.click(await screen.findByLabelText('Actions for project'))
      menu = screen.getByRole('menu', { name: 'Actions for project' })
      expect(rows(menu)).toEqual(['New session', '|', 'Copy path', 'Create worktree…', '|', 'Hide from sidebar'])
    })

    it('shows the Groups block in a workspace menu once a group exists', async () => {
      fx.sessionsData = [projectSession('session-1', 'Feature')]
      fx.workspaceSessionsData = fx.sessionsData
      fx.workspaceGroupsData = [{ id: 'g-web', name: 'web', brief: null }]

      await renderSidebarForSessions('session-1')

      fireEvent.click(await screen.findByLabelText('Actions for project'))
      const menu = screen.getByRole('menu', { name: 'Actions for project' })
      expect(within(menu).getByText('Groups')).toBeTruthy()
      expect(within(menu).getByRole('menuitemcheckbox', { name: 'web' })).toBeTruthy()
      expect(within(menu).getByRole('menuitem', { name: 'Manage groups…' })).toBeTruthy()
    })

    it("shows ⌘N beside New session only in the menu of the workspace on screen, and sets its groups apart", async () => {
      fx.isTauri = false
      fx.platformOs = 'macos'
      fx.sessionsData = [
        projectSession('session-1', 'Feature'),
        projectSession('session-2', 'Elsewhere', { workspace: '/repo/other' }),
      ]
      fx.workspaceSessionsData = fx.sessionsData

      await renderSidebarForSessions('session-1')

      fireEvent.click(screen.getByLabelText('Actions for project'))
      let menu = screen.getByRole('menu', { name: 'Actions for project' })
      const newSession = within(menu).getByRole('menuitem', { name: 'New session' })
      // ⌘N starts a session in the workspace on screen, which is this one.
      expect(newSession.querySelector('kbd')?.textContent).toBe('⌘N')
      expect(newSession.getAttribute('aria-keyshortcuts')).toBe('Meta+N')
      // Entries are grouped by separators: New session · Copy path, Create worktree · Groups · Hide.
      const kinds = Array.from(menu.children).map((el) => (el.getAttribute('role') === 'separator' ? '|' : el.textContent?.replace(/⌘N$/, '')))
      expect(kinds.slice(0, 5)).toEqual(['New session', '|', 'Copy path', 'Create worktree…', '|'])
      expect(kinds.at(-2)).toBe('|')
      expect(kinds.at(-1)).toBe('Hide from sidebar')
      fireEvent.keyDown(menu, { key: 'Escape' })

      // Another workspace's "New session" would not be what ⌘N does: no key shown.
      fireEvent.click(await screen.findByLabelText('Actions for other'))
      menu = screen.getByRole('menu', { name: 'Actions for other' })
      const other = within(menu).getByRole('menuitem', { name: 'New session' })
      expect(other.querySelector('kbd')).toBeNull()
      expect(other.hasAttribute('aria-keyshortcuts')).toBe(false)
    })

    it('has no new-window entry outside the app', async () => {
      fx.isTauri = false
      fx.sessionsData = [projectSession('session-1', 'Feature')]
      fx.workspaceSessionsData = fx.sessionsData

      await renderSidebarForSessions('session-1')

      fireEvent.contextMenu(screen.getByRole('button', { name: /^Feature/ }))
      expect(await screen.findByRole('menuitem', { name: 'Rename' })).toBeTruthy()
      expect(screen.queryByRole('menuitem', { name: 'Open in new window' })).toBeNull()
    })

    it('pins from the row action left of More', async () => {
      fx.sessionsData = [projectSession('session-1', 'Feature')]
      fx.workspaceSessionsData = fx.sessionsData

      await renderSidebarForSessions('session-1')

      const pin = screen.getByRole('button', { name: 'Pin session Feature' })
      const more = screen.getByRole('button', { name: 'More actions for Feature' })
      expect(pin.compareDocumentPosition(more) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
      fireEvent.click(pin)
      expect(setSessionPinnedMutate).toHaveBeenCalledWith(
        { id: 'session-1', pinned: true },
        expect.anything(),
      )
    })

    it('offers Delete but not Rename for a subagent', async () => {
      const child = projectSession('child-1', 'explorer#1: Map the repo', { agent_name: 'explorer#1', parent_session_id: 'session-1' })
      fx.sessionsData = [projectSession('session-1', 'Feature', { subagents: [child] })]
      fx.workspaceSessionsData = fx.sessionsData

      await renderSidebarForSessions('session-1')

      fireEvent.click(screen.getByRole('button', { name: 'Expand 1 subagents' }))
      fireEvent.click(screen.getByRole('button', { name: 'More actions for subagent explorer#1' }))
      const menu = screen.getByRole('menu')
      expect(within(menu).queryByRole('menuitem', { name: 'Rename' })).toBeNull()
      expect(within(menu).getByRole('menuitem', { name: 'Delete session' })).toBeTruthy()
    })

    it('lists a session another workspace ran under its sender, and its mark opens the sender', async () => {
      const from = { session_id: 'session-1', workspace: '/repo/project', title: 'Orders API' }
      const infra = projectSession('infra-1', 'Orders table', { workspace: '/repo/infra', running: true, sent_from: from })
      fx.sessionsData = [projectSession('session-1', 'Orders API', { linked_sessions: [infra] }), infra]
      fx.workspaceSessionsData = fx.sessionsData

      await renderSidebarForSessions('session-1')

      const [toggle] = screen.getAllByRole('button', { name: 'Expand 1 session in other workspaces' })
      expect(within(toggle).getByRole('img', { name: 'A session in another workspace is running' })).toBeTruthy()
      fireEvent.click(toggle)
      fireEvent.click(screen.getByRole('button', { name: 'Orders table, in infra, Running' }))
      expect(navigate).toHaveBeenLastCalledWith({ to: '/$sessionId', params: { sessionId: 'infra-1' } })

      fireEvent.click(screen.getAllByRole('button', { name: 'Open the session that sent this, in project' })[0])
      expect(navigate).toHaveBeenLastCalledWith({ to: '/$sessionId', params: { sessionId: 'session-1' } })
    })

    it('unpins a pinned session from its row action', async () => {
      fx.pinnedSessionsData = [projectSession('pinned-1', 'Pinned review', { pinned_at: '2026-10-18T00:00:00Z' })]
      fx.sessionsData = [projectSession('session-1', 'Feature')]
      fx.workspaceSessionsData = fx.sessionsData

      await renderSidebarForSessions('session-1')

      fireEvent.click(screen.getByRole('button', { name: 'Unpin session Pinned review' }))
      expect(setSessionPinnedMutate).toHaveBeenCalledWith(
        { id: 'pinned-1', pinned: false },
        expect.anything(),
      )
    })

    it('keeps pinning behind long-press on mobile', async () => {
      fx.isMobile = true
      fx.platformOs = 'ios'
      fx.sessionsData = [projectSession('session-1', 'Feature')]
      fx.workspaceSessionsData = fx.sessionsData

      await renderSidebarWithProps({ currentSessionId: 'session-1', workspace: '/repo/project', mobileOpen: true })

      // The inline actions never show; long-press opens the action sheet.
      const actions = screen.getByLabelText('Pin session Feature').parentElement!
      expect(actions.className.split(' ')).toContain('hidden')
      expect(actions.className).not.toContain('group-hover/row:flex')
    })
  })
})
