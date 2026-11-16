import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { loadLastWorkspace } from '@/utils/workspace'
import { useToastStore } from '@/stores/useToastStore'
import {
  browseResponse,
  cleanupSidebarHarness,
  dialogOpen,
  fx,
  navigate,
  renderSidebar,
  resetSidebarHarness,
  workspaceTreeResponse,
} from './harness'

describe('Sidebar workspace trust flow', () => {
  beforeEach(resetSidebarHarness)
  afterEach(cleanupSidebarHarness)

  it('does not navigate or save the last workspace until the user trusts the validated directory', async () => {
    const user = userEvent.setup()
    let visibilityBody: unknown
    let resolveCalled = false
    globalThis.fetch = mock(async (input: unknown, init: unknown) => {
      const url = String(input)
      if (url.includes('/api/agent/workspace/browse')) {
        return new Response(JSON.stringify(browseResponse))
      }
      if (url.endsWith('/api/agent/workspace/visibility')) {
        visibilityBody = JSON.parse(String((init as RequestInit | undefined)?.body))
        return new Response(JSON.stringify({ ...(visibilityBody as object), updated: 0 }))
      }
      if (url.includes('/api/agent/workspace/validate')) {
        return new Response(JSON.stringify({ workspace: '/repo/project' }))
      }
      if (url.includes('/api/agent/workspace/worktrees')) {
        return new Response(JSON.stringify([]))
      }
      if (url.includes('/api/agent/workspace/tree')) {
        return new Response(JSON.stringify(workspaceTreeResponse()))
      }
      if (url.endsWith('/api/agent/sessions/resolve')) {
        resolveCalled = true
        return new Response(null, { status: 500 })
      }
      return new Response(null, { status: 404 })
    }) as typeof fetch
    await renderSidebar()

    expect(dialogOpen).toHaveBeenCalledWith({
      directory: true,
      multiple: false,
      title: 'Open workspace',
    })

    expect(screen.getByRole('heading', { name: 'Let agents work in project?' })).toBeTruthy()
    // What they can do there, and what Undo does and does not cover.
    expect(screen.getByText('They can read, change and delete files in this folder, and run commands there. Undo in the chat brings back files they edited, up to 2 MB each.')).toBeTruthy()
    expect(screen.getByText('/repo/project')).toBeTruthy()
    expect(navigate).not.toHaveBeenCalled()
    expect(loadLastWorkspace()).toBeNull()

    await user.click(screen.getByRole('button', { name: 'Allow and open' }))

    // A new folder is registered so it has a row, then opens as a draft:
    // no session is created until the first message.
    await waitFor(() => {
      expect(navigate).toHaveBeenCalledWith({
        to: '/',
        search: { workspace: '/repo/project' },
        replace: false,
      })
    })
    expect(visibilityBody).toEqual({ workspace: '/repo/project', hidden: false })
    expect(resolveCalled).toBe(false)
    expect(loadLastWorkspace()?.path).toBe('/repo/project')
  })

  it('says Added {folder} once Open workspace… puts a new folder in the sidebar (desktop)', async () => {
    useToastStore.setState({ toasts: [] })
    const user = userEvent.setup()
    await renderSidebar()
    await user.click(screen.getByRole('button', { name: 'Allow and open' }))

    await waitFor(() => expect(useToastStore.getState().toasts.map((toast) => toast.title)).toEqual(['Added project']))
    expect(useToastStore.getState().toasts[0].tone).toBe('info')
  })

  it('says nothing when the folder was already in the sidebar', async () => {
    useToastStore.setState({ toasts: [] })
    fx.sessionsData = [{ id: 'session-1', title: 'Old', agent_name: 'lead', created_at: '2026-05-13T00:00:00Z', updated_at: '2026-05-13T00:00:00Z', mode: 'coding', workspace: '/repo/project' }]
    const user = userEvent.setup()
    await renderSidebar()
    await user.click(screen.getByRole('button', { name: 'Allow and open' }))

    await waitFor(() => expect(navigate).toHaveBeenCalledWith({ to: '/', search: { workspace: '/repo/project' }, replace: false }))
    expect(useToastStore.getState().toasts).toEqual([])
  })

  it('uses the native desktop folder picker on Linux desktop too', async () => {
    fx.platformOs = 'linux'

    await renderSidebar()

    expect(dialogOpen).toHaveBeenCalledWith({
      directory: true,
      multiple: false,
      title: 'Open workspace',
    })
    expect(screen.getByRole('heading', { name: 'Let agents work in project?' })).toBeTruthy()
    expect(screen.getByText('/repo/project')).toBeTruthy()
  })

  it('lets the user go back from the trust warning without opening the workspace', async () => {
    const user = userEvent.setup()
    await renderSidebar()

    expect(await screen.findByRole('heading', { name: 'Let agents work in project?' })).toBeTruthy()
    await user.click(screen.getByRole('button', { name: /^back$/i }))

    expect(screen.getByText('Open workspace')).toBeTruthy()
    expect(navigate).not.toHaveBeenCalled()
    expect(loadLastWorkspace()).toBeNull()
  })

  it('shows validation errors without showing the trust confirmation', async () => {
    fx.validateError = new Error('Workspace does not exist')

    await renderSidebar()

    expect(await screen.findByText('Workspace does not exist')).toBeTruthy()
    expect(screen.queryByRole('heading', { name: 'Let agents work in project?' })).toBeNull()
    expect(navigate).not.toHaveBeenCalled()
    expect(loadLastWorkspace()).toBeNull()
  })

  it('keeps the server-local browser fallback outside desktop', async () => {
    const user = userEvent.setup()
    fx.isTauri = false

    await renderSidebar()

    expect(dialogOpen).not.toHaveBeenCalled()
    expect(await screen.findByText('/repo/project')).toBeTruthy()

    await user.click(screen.getByRole('button', { name: /open this folder/i }))

    expect(screen.getByRole('heading', { name: 'Let agents work in project?' })).toBeTruthy()
    expect(dialogOpen).not.toHaveBeenCalled()
    expect(navigate).not.toHaveBeenCalled()
  })

  it('uses the server-local browser when the desktop app is connected to a remote backend', async () => {
    const user = userEvent.setup()
    fx.appBackendStatus = {
      base_url: 'http://192.168.1.20:4082',
      sidecar_running: false,
      external: true,
      supports_bundled: true,
      servers: [],
    }

    await renderSidebar()

    expect(dialogOpen).not.toHaveBeenCalled()
    expect(await screen.findByText('/repo/project')).toBeTruthy()

    await user.click(screen.getByRole('button', { name: /open this folder/i }))

    expect(screen.getByRole('heading', { name: 'Let agents work in project?' })).toBeTruthy()
    expect(dialogOpen).not.toHaveBeenCalled()
    expect(navigate).not.toHaveBeenCalled()
  })
})
