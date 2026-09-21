import { describe, expect, it } from 'bun:test'
import { formatBackendConnectionLabel } from '@/lib/app-backend'
import type { AppBackendStatus } from '@/lib/app-backend'

function status(overrides: Partial<AppBackendStatus> = {}): AppBackendStatus {
  return {
    base_url: 'http://127.0.0.1:4082',
    sidecar_running: true,
    external: false,
    supports_bundled: true,
    servers: [],
    ...overrides,
  }
}

describe('formatBackendConnectionLabel', () => {
  it('labels a bundled sidecar as builtin', () => {
    expect(formatBackendConnectionLabel(status({ mode: 'bundled' }), '/api')).toBe('builtin')
  })

  it('uses the saved server name for an external backend', () => {
    expect(
      formatBackendConnectionLabel(
        status({
          mode: 'external',
          external: true,
          base_url: 'http://192.168.1.12:4082',
          servers: [{ base_url: 'http://192.168.1.12:4082', name: 'Studio LAN' }],
        }),
        '/api',
      ),
    ).toBe('Studio LAN')
  })

  it('falls back to the host, never a path or token, when the saved server is unnamed', () => {
    expect(
      formatBackendConnectionLabel(
        status({
          mode: 'external',
          external: true,
          base_url: 'http://192.168.1.12:4082/api',
          token: 'secret-token',
          servers: [{ base_url: 'http://192.168.1.12:4082/api', name: null }],
        }),
        '/api',
      ),
    ).toBe('192.168.1.12')
  })

  it('treats a relative /api fallback as builtin when status is unavailable', () => {
    expect(formatBackendConnectionLabel(null, '/api')).toBe('builtin')
  })
})
