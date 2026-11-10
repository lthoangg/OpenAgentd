import { afterEach, describe, expect, it } from 'bun:test'
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
    expect(formatBackendConnectionLabel(status({ mode: 'bundled' }), '/api')).toBe('built-in')
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
    expect(formatBackendConnectionLabel(null, '/api')).toBe('built-in')
  })

  describe('on an account bridge (phone)', () => {
    afterEach(() => window.localStorage.clear())
    const bridge = (servers: AppBackendStatus['servers'] = []) => status({
      mode: 'external',
      external: true,
      base_url: 'http://127.0.0.1:5999',
      servers,
      account_device: { device_id: 'dev-mac', fingerprint: '3F9A 21C4', kind: 'macos' },
    })

    it('names the computer as its Servers row does, never 127.0.0.1', () => {
      expect(formatBackendConnectionLabel(bridge(), '/api')).toBe('macOS · 3F9A 21C4')
    })

    it('uses the name typed for the saved LAN server that is this computer', () => {
      window.localStorage.setItem('openagentd.cloud.lanComputers', JSON.stringify({ '3F9A21C4': 'http://192.168.1.20:4082' }))
      expect(formatBackendConnectionLabel(bridge([{ base_url: 'http://192.168.1.20:4082/', name: 'Studio Mac' }]), '/api')).toBe('Studio Mac')
      // Saved without a name: kind and fingerprint.
      expect(formatBackendConnectionLabel(bridge([{ base_url: 'http://192.168.1.20:4082', name: null }]), '/api')).toBe('macOS · 3F9A 21C4')
    })

    it('shows only the fingerprint for a kind outside the known set', () => {
      expect(formatBackendConnectionLabel({ ...bridge(), account_device: { device_id: 'd', fingerprint: '9C02 E1B7', kind: '<b>x</b>' } }, '/api')).toBe('9C02 E1B7')
    })
  })
})
