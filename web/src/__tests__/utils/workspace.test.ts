import { beforeEach, describe, expect, it } from 'bun:test'
import {
  loadWorkspaceEntries,
  loadWorkspaces,
  loadLastWorkspace,
  saveWorkspace,
  saveLastWorkspace,
  shouldRestoreLastWorkspace,
  workspaceFromSession,
} from '@/utils/workspace'

const STORAGE_KEY = 'oa-coding-workspaces'

describe('coding workspace persistence', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  it('preserves creation order when an existing workspace is selected again', () => {
    const first = saveWorkspace('/repo/alpha')
    const second = saveWorkspace('/repo/beta')

    const selectedAgain = saveWorkspace('/repo/alpha')

    expect(selectedAgain.createdAt).toBe(first.createdAt)
    expect(loadWorkspaces()).toEqual(['/repo/alpha', '/repo/beta'])
    expect(loadWorkspaceEntries().map((entry) => entry.createdAt)).toEqual([
      first.createdAt,
      second.createdAt,
    ])
  })

  it('migrates legacy string entries without reordering them', () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(['/repo/old-a', '/repo/old-b']))

    expect(loadWorkspaces()).toEqual(['/repo/old-a', '/repo/old-b'])

    saveWorkspace('/repo/old-b')

    const entries = loadWorkspaceEntries()
    expect(entries.map((entry) => entry.path)).toEqual(['/repo/old-a', '/repo/old-b'])
    expect(Date.parse(entries[0].createdAt)).toBeLessThan(Date.parse(entries[1].createdAt))
  })

  it('remembers the last opened coding workspace', () => {
    saveLastWorkspace('/repo/alpha')
    const beta = saveLastWorkspace('/repo/beta')

    expect(loadLastWorkspace()).toEqual(beta)
    expect(loadWorkspaces()).toEqual(['/repo/alpha', '/repo/beta'])
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

  it('does not reuse a previous workspace while direct session details are loading', () => {
    expect(workspaceFromSession('sid', undefined)).toBeNull()
  })

  it('uses loaded session workspace for direct coding session links', () => {
    expect(workspaceFromSession('sid', '/repo/session')).toBe('/repo/session')
  })
})
