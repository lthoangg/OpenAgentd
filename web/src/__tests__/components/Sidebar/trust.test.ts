import { describe, expect, it } from 'bun:test'
import {
  consumeTrustedWorkspace,
  selectTrustedWorkspace,
} from '@/components/Sidebar/trust'

describe('Sidebar helpers', () => {
  it('exports trust helpers used by the component', async () => {
    expect(await selectTrustedWorkspace('/repo/project', async (path) => path)).toBe('/repo/project')
    expect(await selectTrustedWorkspace(null, async (path) => path)).toBeNull()
    expect(consumeTrustedWorkspace('/repo/project')).toEqual({
      workspaceToOpen: '/repo/project',
      nextTrustWorkspace: null,
      nextDialogOpen: false,
    })
    expect(consumeTrustedWorkspace(null)).toEqual({
      workspaceToOpen: null,
      nextTrustWorkspace: null,
      nextDialogOpen: true,
    })
  })
})
