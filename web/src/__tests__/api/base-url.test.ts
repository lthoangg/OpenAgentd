import { afterEach, beforeEach, describe, expect, it } from 'bun:test'

const originalEnv = import.meta.env.VITE_API_BASE_URL

declare global {
  interface Window {
    __OAD_API_BASE_URL__?: string
    __OAD_BACKEND_UNAVAILABLE__?: boolean
  }
}

beforeEach(() => {
  delete window.__OAD_API_BASE_URL__
  delete window.__OAD_BACKEND_UNAVAILABLE__
  delete import.meta.env.VITE_API_BASE_URL
})

afterEach(() => {
  delete window.__OAD_API_BASE_URL__
  delete window.__OAD_BACKEND_UNAVAILABLE__
  if (originalEnv !== undefined) {
    import.meta.env.VITE_API_BASE_URL = originalEnv
  } else {
    delete import.meta.env.VITE_API_BASE_URL
  }
})

describe('apiBaseUrl', () => {
  it('defaults to same-origin /api when no desktop or env override exists', async () => {
    delete import.meta.env.VITE_API_BASE_URL
    const { apiBaseUrl, apiUrl } = await import('@/api/base-url')

    expect(apiBaseUrl()).toBe('/api')
    expect(apiUrl('/health/live')).toBe('/api/health/live')
  })

  it('uses an unreachable sentinel when desktop reports no backend', async () => {
    window.__OAD_BACKEND_UNAVAILABLE__ = true
    const { apiBaseUrl, apiUrl } = await import('@/api/base-url')

    expect(apiBaseUrl()).toBe('oad-backend-unavailable://api')
    expect(apiUrl('/health/live')).toBe('oad-backend-unavailable://api/health/live')
  })

  it('normalizes desktop base URL and appends /api exactly once', async () => {
    window.__OAD_API_BASE_URL__ = 'http://127.0.0.1:4082///'
    const { apiBaseUrl, apiUrl } = await import('@/api/base-url')

    expect(apiBaseUrl()).toBe('http://127.0.0.1:4082/api')
    expect(apiUrl('agent/status')).toBe('http://127.0.0.1:4082/api/agent/status')
  })

  it('does not double-append /api when the injected URL already includes it', async () => {
    window.__OAD_API_BASE_URL__ = 'http://localhost:4082/api'
    const { apiBaseUrl, apiUrl } = await import('@/api/base-url')

    expect(apiBaseUrl()).toBe('http://localhost:4082/api')
    expect(apiUrl('/settings/denied-paths')).toBe('http://localhost:4082/api/settings/denied-paths')
  })

  it('updates the desktop API base URL at runtime and notifies listeners', async () => {
    const calls: string[] = []
    const { apiBaseUrl, onApiBaseUrlChange, setApiBaseUrl } = await import('@/api/base-url')
    const unsubscribe = onApiBaseUrlChange(() => calls.push(apiBaseUrl()))

    setApiBaseUrl('http://127.0.0.1:5000')
    setApiBaseUrl('http://127.0.0.1:5001/api')
    unsubscribe()
    setApiBaseUrl('http://127.0.0.1:5002')

    expect(calls).toEqual(['http://127.0.0.1:5000/api', 'http://127.0.0.1:5001/api'])
    expect(apiBaseUrl()).toBe('http://127.0.0.1:5002/api')
  })
})
