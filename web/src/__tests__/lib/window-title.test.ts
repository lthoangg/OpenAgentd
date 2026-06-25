import { describe, expect, it } from 'bun:test'
import { buildDesktopWindowTitle } from '@/lib/window-title'

describe('buildDesktopWindowTitle', () => {
  it('uses only the workspace basename for coding windows', () => {
    expect(buildDesktopWindowTitle({ mode: 'coding', workspace: '/Users/name/Workspace A' })).toBe('Workspace A')
  })

  it('uses only the session title for normal chat windows', () => {
    expect(buildDesktopWindowTitle({ mode: 'normal', sessionTitle: 'Refactor auth flow' })).toBe('Refactor auth flow')
  })

  it('falls back to the app name when no title is available', () => {
    expect(buildDesktopWindowTitle({ mode: 'normal', sessionTitle: '   ' })).toBe('OpenAgentd')
  })
})
