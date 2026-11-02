import { beforeEach, describe, expect, it, mock } from 'bun:test'

let isTauri = true
let os = 'macos'
const setBadgeCount = mock(async (..._args: unknown[]) => {})
const setTitle = mock(async (..._args: unknown[]) => {})
const invoke = mock(async (..._args: unknown[]) => {})
mock.module('@/hooks/use-platform', () => ({ getPlatform: () => ({ isTauri, os }) }))
mock.module('@tauri-apps/api/window', () => ({ getCurrentWindow: () => ({ setBadgeCount, setTitle }) }))
mock.module('@tauri-apps/api/core', () => ({ invoke }))

const { buildDesktopWindowTitle, syncDesktopBadgeCount, syncDesktopWindowTitle } = await import('@/lib/window-title')

beforeEach(() => {
  isTauri = true
  os = 'macos'
  setBadgeCount.mockClear()
  setTitle.mockClear()
  invoke.mockClear()
  document.title = 'OpenAgentd'
})

describe('buildDesktopWindowTitle', () => {
  it('joins the workspace and session title', () => {
    expect(buildDesktopWindowTitle({ workspace: '/Users/name/Workspace A', sessionTitle: 'Fix updater restart' })).toBe('Workspace A - Fix updater restart')
  })

  it('falls back to the workspace basename for coding windows without a session title', () => {
    expect(buildDesktopWindowTitle({ workspace: '/Users/name/Workspace A' })).toBe('Workspace A')
  })

  it('uses only the session title when no workspace is attached', () => {
    expect(buildDesktopWindowTitle({ sessionTitle: 'Refactor auth flow' })).toBe('Refactor auth flow')
  })

  it('falls back to the app name when no title is available', () => {
    expect(buildDesktopWindowTitle({ sessionTitle: '   ' })).toBe('OpenAgentd')
  })

  it('prefers the chat label over the workspace basename', () => {
    expect(
      buildDesktopWindowTitle({ workspace: '/Users/name', workspaceName: 'Chat' }),
    ).toBe('Chat')
  })

  it('lets the session title win over the workspace label', () => {
    expect(
      buildDesktopWindowTitle({
        workspace: '/Users/name',
        workspaceName: 'Chat',
        sessionTitle: 'Trip planning',
      }),
    ).toBe('Chat - Trip planning')
  })

  it('does not repeat the workspace when the session title is the same', () => {
    expect(buildDesktopWindowTitle({ workspaceName: 'Chat', sessionTitle: 'Chat' })).toBe('Chat')
  })

  it('truncates a long session title but keeps the workspace', () => {
    const title = buildDesktopWindowTitle({ workspaceName: 'app', sessionTitle: 'x'.repeat(200) })
    expect(title.startsWith('app - xxx')).toBe(true)
    expect(title.endsWith('…')).toBe(true)
    expect(title.length).toBe('app - '.length + 60)
  })

  it('counts sessions that need you in front of the title', () => {
    expect(buildDesktopWindowTitle({ workspaceName: 'app', sessionTitle: 'Fix updater restart', needsYou: 2 })).toBe('(2) app - Fix updater restart')
    expect(buildDesktopWindowTitle({ sessionTitle: 'Fix updater restart', needsYou: 0 })).toBe('Fix updater restart')
  })
})

describe('syncDesktopWindowTitle', () => {
  it('sets document.title and the native window title, skipping repeats', async () => {
    syncDesktopWindowTitle({ workspaceName: 'app', sessionTitle: 'First' })
    syncDesktopWindowTitle({ workspaceName: 'app', sessionTitle: 'First' })
    syncDesktopWindowTitle({ workspaceName: 'app', sessionTitle: 'Second' })
    await Promise.resolve()
    await new Promise((r) => setTimeout(r, 0))

    expect(document.title).toBe('app - Second')
    expect(setTitle.mock.calls).toEqual([['app - First'], ['app - Second']])
  })

  it('leaves the native title alone outside the desktop app', async () => {
    isTauri = false

    syncDesktopWindowTitle({ workspaceName: 'app', sessionTitle: 'Web only' })
    await new Promise((r) => setTimeout(r, 0))

    expect(document.title).toBe('app - Web only')
    expect(setTitle).not.toHaveBeenCalled()
  })
})

describe('syncDesktopBadgeCount', () => {
  it('has the desktop shell badge the app with the count, and clear it at zero', async () => {
    await syncDesktopBadgeCount(3)
    await syncDesktopBadgeCount(0)

    expect(invoke.mock.calls).toEqual([
      ['set_attention_badge', { count: 3 }],
      ['set_attention_badge', { count: 0 }],
    ])
    expect(setBadgeCount).not.toHaveBeenCalled()
  })

  it.each(['windows', 'linux'])('does the same on %s', async (platform) => {
    os = platform
    await syncDesktopBadgeCount(2)
    expect(invoke.mock.calls).toEqual([['set_attention_badge', { count: 2 }]])
  })

  it('leaves the phone apps to badge their own icon', async () => {
    os = 'ios'

    await syncDesktopBadgeCount(3)
    await syncDesktopBadgeCount(0)

    expect(setBadgeCount.mock.calls).toEqual([[3], [undefined]])
    expect(invoke).not.toHaveBeenCalled()
  })

  it('does not call the shell outside the desktop app', async () => {
    isTauri = false

    await syncDesktopBadgeCount(3)

    expect(setBadgeCount).not.toHaveBeenCalled()
    expect(invoke).not.toHaveBeenCalled()
  })

  it('survives a shell without the command', async () => {
    invoke.mockImplementation(async () => {
      throw new Error('unknown command')
    })
    try {
      await syncDesktopBadgeCount(1)
    } finally {
      invoke.mockImplementation(async () => {})
    }
  })
})

describe('the count in the title', () => {
  it('puts the count in front of a browser tab title, and takes it off at zero', async () => {
    isTauri = false
    document.title = 'Scheduler'

    await syncDesktopBadgeCount(2)
    expect(document.title).toBe('(2) Scheduler')
    await syncDesktopBadgeCount(3)
    expect(document.title).toBe('(3) Scheduler')
    await syncDesktopBadgeCount(0)
    expect(document.title).toBe('Scheduler')
  })

  it('does not stack a second count on a title the chat layout already prefixed', async () => {
    isTauri = false
    document.title = 'app - Fix'
    await syncDesktopBadgeCount(1)

    // The chat layout writes its own title with the new count first…
    syncDesktopWindowTitle({ workspaceName: 'app', sessionTitle: 'Fix', needsYou: 2 })
    expect(document.title).toBe('(2) app - Fix')
    // …and the badge sync that follows finds it already there.
    await syncDesktopBadgeCount(2)
    expect(document.title).toBe('(2) app - Fix')
    await syncDesktopBadgeCount(0)
    expect(document.title).toBe('app - Fix')
  })

  it('does not touch a title that merely starts with digits', async () => {
    isTauri = false
    document.title = '(3) things'
    await syncDesktopBadgeCount(0)
    expect(document.title).toBe('(3) things')
  })

  it('updates the native window title in the desktop app too', async () => {
    document.title = 'Scheduler'
    await syncDesktopBadgeCount(4)
    await new Promise((r) => setTimeout(r, 0))
    expect(setTitle.mock.calls.at(-1)).toEqual(['(4) Scheduler'])
  })
})
