import { beforeEach, describe, expect, it } from 'bun:test'
import {
  absoluteWorkspacePath,
  loadWorkspaceEntries,
  loadLastWorkspace,
  saveWorkspace,
  saveLastWorkspace,
  shouldRestoreLastWorkspace,
  workspaceFromSession,
} from '@/utils/workspace'
import { checkoutLabel, formatCheckoutLabel } from '@/utils/checkout-label'

const STORAGE_KEY = 'oa-coding-workspaces'

describe('checkoutLabel', () => {
  const repositories = [
    {
      path: '/code/openagentd',
      name: 'openagentd',
      worktrees: [
        { path: '/wt/openagentd-1a2b/fix-login', name: 'fix-login' },
        { path: '/code/openagentd/web/app', name: 'web/app' },
      ],
    },
  ]

  it('names a worktree by its repository and its own name', () => {
    const label = checkoutLabel('/wt/openagentd-1a2b/fix-login', repositories, null)
    expect(label).toEqual({ workspace: 'openagentd', checkout: 'fix-login' })
    expect(formatCheckoutLabel(label)).toBe('openagentd (fix-login)')
  })

  it('names a subfolder the same way', () => {
    expect(formatCheckoutLabel(checkoutLabel('/code/openagentd/web/app/', repositories, null))).toBe('openagentd (web/app)')
  })

  it('keeps the main checkout to the repository name', () => {
    expect(formatCheckoutLabel(checkoutLabel('/code/openagentd', repositories, null))).toBe('openagentd')
  })

  it('falls back to the basename, or Chat, for paths the tree does not know', () => {
    expect(formatCheckoutLabel(checkoutLabel('/elsewhere/tool', repositories, null))).toBe('tool')
    expect(formatCheckoutLabel(checkoutLabel('/home/me', undefined, { path: '/home/me', name: 'Chat' }))).toBe('Chat')
  })
})

describe('coding workspace persistence', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  it('preserves creation order when an existing workspace is selected again', () => {
    const first = saveWorkspace('/repo/alpha')
    const second = saveWorkspace('/repo/beta')

    const selectedAgain = saveWorkspace('/repo/alpha')

    expect(selectedAgain.createdAt).toBe(first.createdAt)
    expect(loadWorkspaceEntries().map((entry) => entry.path)).toEqual(['/repo/alpha', '/repo/beta'])
    expect(loadWorkspaceEntries().map((entry) => entry.createdAt)).toEqual([
      first.createdAt,
      second.createdAt,
    ])
  })

  it('migrates legacy string entries without reordering them', () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(['/repo/old-a', '/repo/old-b']))

    expect(loadWorkspaceEntries().map((entry) => entry.path)).toEqual(['/repo/old-a', '/repo/old-b'])

    saveWorkspace('/repo/old-b')

    const entries = loadWorkspaceEntries()
    expect(entries.map((entry) => entry.path)).toEqual(['/repo/old-a', '/repo/old-b'])
    expect(Date.parse(entries[0].createdAt)).toBeLessThan(Date.parse(entries[1].createdAt))
  })

  it('remembers the last opened coding workspace', () => {
    saveLastWorkspace('/repo/alpha')
    const beta = saveLastWorkspace('/repo/beta')

    expect(loadLastWorkspace()).toEqual(beta)
    expect(loadWorkspaceEntries().map((entry) => entry.path)).toEqual(['/repo/alpha', '/repo/beta'])
  })

  it('returns null when the last workspace id no longer points to a saved workspace', () => {
    const saved = saveLastWorkspace('/repo/project')
    localStorage.setItem(STORAGE_KEY, JSON.stringify([{ ...saved, id: 'other' }]))

    expect(loadLastWorkspace()).toBeNull()
  })

  it('restores the last workspace only on the new-session route', () => {
    expect(shouldRestoreLastWorkspace(undefined, '/')).toBe(true)
    expect(shouldRestoreLastWorkspace('sid', '/')).toBe(false)
  })

  it('does not restore while navigating to another route', () => {
    expect(shouldRestoreLastWorkspace(undefined, '/telemetry')).toBe(false)
    expect(shouldRestoreLastWorkspace(undefined, '/coding')).toBe(false)
  })

  it('does not restore in a window opened with New Window', () => {
    expect(shouldRestoreLastWorkspace(undefined, '/', true)).toBe(false)
  })

  it('does not restore over a new-session draft', () => {
    expect(shouldRestoreLastWorkspace(undefined, '/', false, '/repo/project')).toBe(false)
  })

  it('does not reuse a previous workspace while direct session details are loading', () => {
    expect(workspaceFromSession('sid', undefined)).toBeNull()
  })

  it('uses loaded session workspace for direct coding session links', () => {
    expect(workspaceFromSession('sid', '/repo/session')).toBe('/repo/session')
  })
})

describe('absoluteWorkspacePath', () => {
  it('joins a relative path onto the workspace, with or without its trailing slash', () => {
    expect(absoluteWorkspacePath('/Users/me/repo', 'src/app.ts')).toBe('/Users/me/repo/src/app.ts')
    expect(absoluteWorkspacePath('/Users/me/repo/', 'src/app.ts')).toBe('/Users/me/repo/src/app.ts')
    expect(absoluteWorkspacePath('/Users/me/repo', './src/app.ts')).toBe('/Users/me/repo/src/app.ts')
  })

  it('keeps a path that is already absolute', () => {
    expect(absoluteWorkspacePath('/Users/me/repo', '/tmp/x.txt')).toBe('/tmp/x.txt')
    expect(absoluteWorkspacePath('C:\\work\\repo', 'D:\\x.txt')).toBe('D:\\x.txt')
  })

  it('writes a Windows workspace with backslashes throughout', () => {
    expect(absoluteWorkspacePath('C:\\work\\repo\\', 'src/app.ts')).toBe('C:\\work\\repo\\src\\app.ts')
    expect(absoluteWorkspacePath('\\\\server\\share\\repo', 'a/b.md')).toBe('\\\\server\\share\\repo\\a\\b.md')
  })
})
