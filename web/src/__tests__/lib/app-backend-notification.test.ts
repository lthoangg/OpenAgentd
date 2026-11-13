import { describe, expect, it } from 'bun:test'
import { notificationServerName, titleWithServer } from '@/lib/app-backend'
import type { AppBackendStatus } from '@/lib/app-backend'

/** A phone on a saved LAN server. */
function phone(overrides: Partial<AppBackendStatus> = {}): AppBackendStatus {
  return {
    base_url: 'http://192.168.1.20:4082',
    mode: 'external',
    sidecar_running: false,
    external: true,
    supports_bundled: false,
    servers: [{ base_url: 'http://192.168.1.20:4082', name: 'Studio Mac' }],
    ...overrides,
  }
}

const LAB = { base_url: 'http://192.168.1.30:4082', name: 'Lab' }
const BRIDGE = { device_id: 'dev-mac', fingerprint: '3F9A 21C4', kind: 'macos' }

describe('notificationServerName', () => {
  it('names nothing while the app knows one server', () => {
    expect(notificationServerName(phone())).toBeNull()
    expect(notificationServerName(null)).toBeNull()
  })

  it('names the server in use, as the switcher does, once there are several', () => {
    const several = phone({ servers: [{ base_url: 'http://192.168.1.20:4082', name: 'Studio Mac' }, LAB] })
    expect(notificationServerName(several)).toBe('Studio Mac')
  })

  it('uses the computer\'s own name for a saved server you did not name', () => {
    const unnamed = phone({
      servers: [{ base_url: 'http://192.168.1.20:4082', name: null }, LAB],
      computer_names: { 'http://192.168.1.20:4082': 'studio-mini' },
    })
    expect(notificationServerName(unnamed)).toBe('studio-mini')
  })

  it('always names an account computer, even as the only server', () => {
    const bridge = phone({ base_url: 'http://127.0.0.1:5999', servers: [], account_device: BRIDGE, computer_names: { 'dev-mac': 'studio-mini' } })
    expect(notificationServerName(bridge)).toBe('studio-mini')
  })

  it('names an account computer by kind and key until the app has been on it', () => {
    const bridge = phone({ base_url: 'http://127.0.0.1:5999', servers: [], account_device: BRIDGE })
    expect(notificationServerName(bridge)).toBe('macOS · 3F9A 21C4')
  })

  it('counts an account computer the app has been on as another server', () => {
    const withAccount = phone({ computer_names: { 'dev-mac': 'studio-mini' } })
    expect(notificationServerName(withAccount)).toBe('Studio Mac')
  })

  it('leaves the desktop\'s built-in server unnamed until there is another', () => {
    const builtIn = phone({ base_url: 'http://127.0.0.1:4082', mode: 'bundled', external: false, supports_bundled: true, sidecar_running: true, servers: [], computer_names: { 'built-in': 'studio-mini' } })
    expect(notificationServerName(builtIn)).toBeNull()
    expect(notificationServerName({ ...builtIn, servers: [LAB] })).toBe('studio-mini')
    expect(notificationServerName({ ...builtIn, servers: [LAB], computer_names: {} })).toBe('Built-in server')
  })
})

describe('titleWithServer', () => {
  it('puts the name after the status and the workspace', () => {
    expect(titleWithServer('Done · web', 'studio-mini')).toBe('Done · web · studio-mini')
    expect(titleWithServer('Needs you', 'studio-mini')).toBe('Needs you · studio-mini')
  })

  it('leaves the title alone without a name', () => {
    expect(titleWithServer('Done · web', null)).toBe('Done · web')
    expect(titleWithServer('Done · web', '  ')).toBe('Done · web')
  })

  it('cuts a long name, never the status or the workspace', () => {
    const titled = titleWithServer('Done · web', 'é'.repeat(60))
    expect(titled.startsWith('Done · web · ')).toBe(true)
    const name = titled.slice('Done · web · '.length)
    expect(Array.from(new Intl.Segmenter().segment(name))).toHaveLength(40)
    expect(name.endsWith('…')).toBe(true)
  })
})
