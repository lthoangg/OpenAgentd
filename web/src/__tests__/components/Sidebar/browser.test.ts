import { describe, expect, it, mock } from 'bun:test'
import {
  loadWorkspaceBrowser,
  shouldUseServerWorkspaceBrowser,
  validateTrustedWorkspace,
} from '@/components/Sidebar/browser'
import { browseResponse, fx, originalFetch } from './harness'

describe('Sidebar helpers', () => {
  it('exports workspace browser helpers used by the component', async () => {
    globalThis.fetch = mock(async (input: unknown) => {
      const url = String(input)
      if (url.includes('/api/agent/workspace/browse')) {
        return new Response(JSON.stringify(browseResponse))
      }
      if (url.includes('/api/agent/workspace/validate')) {
        return new Response(JSON.stringify({ workspace: '/repo/project' }))
      }
      return new Response(null, { status: 404 })
    }) as typeof fetch

    expect(await loadWorkspaceBrowser()).toEqual(browseResponse)
    expect(await validateTrustedWorkspace('/repo/project')).toBe('/repo/project')

    fx.isTauri = false
    expect(await shouldUseServerWorkspaceBrowser(fx.isTauri, false)).toBe(true)

    fx.isTauri = true
    fx.appBackendStatus = {
      base_url: 'https://remote.example.com',
      sidecar_running: false,
      external: true,
      supports_bundled: false,
      servers: [],
    }
    expect(await shouldUseServerWorkspaceBrowser(fx.isTauri, false)).toBe(true)

    globalThis.fetch = originalFetch
  })
})
