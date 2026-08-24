import { beforeEach, describe, expect, it } from 'bun:test'
import {
  loadCodingWorkspaceEntries,
  loadCodingWorkspaces,
  loadLastCodingWorkspace,
  saveCodingWorkspace,
  saveLastCodingWorkspace,
  shouldRestoreLastCodingWorkspace,
  workspaceFromSession,
} from '@/utils/workspace'

const STORAGE_KEY = 'oa-coding-workspaces'

describe('coding workspace persistence', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  it('preserves creation order when an existing workspace is selected again', () => {
    const first = saveCodingWorkspace('/repo/alpha')
    const second = saveCodingWorkspace('/repo/beta')

    const selectedAgain = saveCodingWorkspace('/repo/alpha')

    expect(selectedAgain.createdAt).toBe(first.createdAt)
    expect(loadCodingWorkspaces()).toEqual(['/repo/alpha', '/repo/beta'])
    expect(loadCodingWorkspaceEntries().map((entry) => entry.createdAt)).toEqual([
      first.createdAt,
      second.createdAt,
    ])
  })

  it('migrates legacy string entries without reordering them', () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(['/repo/old-a', '/repo/old-b']))

    expect(loadCodingWorkspaces()).toEqual(['/repo/old-a', '/repo/old-b'])

    saveCodingWorkspace('/repo/old-b')

    const entries = loadCodingWorkspaceEntries()
    expect(entries.map((entry) => entry.path)).toEqual(['/repo/old-a', '/repo/old-b'])
    expect(Date.parse(entries[0].createdAt)).toBeLessThan(Date.parse(entries[1].createdAt))
  })

  it('remembers the last opened coding workspace', () => {
    saveLastCodingWorkspace('/repo/alpha')
    const beta = saveLastCodingWorkspace('/repo/beta')

    expect(loadLastCodingWorkspace()).toEqual(beta)
    expect(loadCodingWorkspaces()).toEqual(['/repo/alpha', '/repo/beta'])
  })

  it('returns null when the last workspace id no longer points to a saved workspace', () => {
    const saved = saveLastCodingWorkspace('/repo/project')
    localStorage.setItem(STORAGE_KEY, JSON.stringify([{ ...saved, id: 'other' }]))

    expect(loadLastCodingWorkspace()).toBeNull()
  })

  it('restores the last workspace only on the bare coding route', () => {
    expect(shouldRestoreLastCodingWorkspace(undefined, '/coding')).toBe(true)
    expect(shouldRestoreLastCodingWorkspace('sid', '/coding')).toBe(false)
  })

  it('does not restore while navigating away from coding mode', () => {
    expect(shouldRestoreLastCodingWorkspace(undefined, '/')).toBe(false)
    expect(shouldRestoreLastCodingWorkspace(undefined, '/other')).toBe(false)
  })

  it('does not reuse a previous workspace while direct session details are loading', () => {
    expect(workspaceFromSession('sid', undefined)).toBeNull()
  })

  it('uses loaded session workspace for direct coding session links', () => {
    expect(workspaceFromSession('sid', '/repo/session')).toBe('/repo/session')
  })
})
