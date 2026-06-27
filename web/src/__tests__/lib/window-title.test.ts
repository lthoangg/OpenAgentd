import { describe, expect, it } from 'bun:test'
import { buildDesktopWindowTitle } from '@/lib/window-title'

describe('buildDesktopWindowTitle', () => {
  it('uses the session title for coding windows when available', () => {
    expect(buildDesktopWindowTitle({ mode: 'coding', workspace: '/Users/name/Workspace A', sessionTitle: 'Fix updater restart' })).toBe('Fix updater restart')
  })

  it('falls back to the workspace basename for coding windows without a session title', () => {
    expect(buildDesktopWindowTitle({ mode: 'coding', workspace: '/Users/name/Workspace A' })).toBe('Workspace A')
  })

  it('uses only the session title for normal chat windows', () => {
    expect(buildDesktopWindowTitle({ mode: 'normal', sessionTitle: 'Refactor auth flow' })).toBe('Refactor auth flow')
  })

  it('falls back to the app name when no title is available', () => {
    expect(buildDesktopWindowTitle({ mode: 'normal', sessionTitle: '   ' })).toBe('OpenAgentd')
  })
})
