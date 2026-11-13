/**
 * What a computer is called: the name it gave for itself once the app has
 * seen it, else its system and key; the key joins a name only while two
 * computers share it. And which key a server's name is remembered under.
 */
import { describe, expect, it } from 'bun:test'
import {
  accountComputerTitle,
  computerNameKey,
  deviceTitles,
  formatBackendConnectionLabel,
  savedServerTitle,
  type AppBackendStatus,
} from '@/lib/app-backend'

const MAC = { device_id: 'dev-mac', fingerprint: '3F9A 21C4', kind: 'macos' }
const MINI = { device_id: 'dev-mini', fingerprint: '81BC 77E0', kind: 'macos' }
const BOX = { device_id: 'dev-box', fingerprint: 'C2D0 5A19', kind: 'linux' }

function status(overrides: Partial<AppBackendStatus> = {}): AppBackendStatus {
  return { base_url: 'http://127.0.0.1:5999', mode: 'external', sidecar_running: false, external: true, supports_bundled: false, servers: [], ...overrides }
}

describe('accountComputerTitle', () => {
  it('is the name the computer gave, once the app has seen it', () => {
    expect(accountComputerTitle(MAC, { 'dev-mac': 'Work' })).toBe('Work')
  })

  it('falls back to system and key for a computer never connected to, and on an older shell', () => {
    expect(accountComputerTitle(MAC, { 'dev-mini': 'Personal' })).toBe('macOS · 3F9A 21C4')
    expect(accountComputerTitle(MAC, undefined)).toBe('macOS · 3F9A 21C4')
    expect(accountComputerTitle(MAC)).toBe('macOS · 3F9A 21C4')
  })

  it('does not show a name that is only spaces', () => {
    expect(accountComputerTitle(MAC, { 'dev-mac': '   ' })).toBe('macOS · 3F9A 21C4')
  })
})

describe('deviceTitles', () => {
  it('gives each computer its own name', () => {
    const titles = deviceTitles([MAC, MINI, BOX], { 'dev-mac': 'Work', 'dev-mini': 'Personal' })
    expect([...titles.entries()]).toEqual([['dev-mac', 'Work'], ['dev-mini', 'Personal'], ['dev-box', 'Linux · C2D0 5A19']])
  })

  it('adds the key after a name only while two computers share it', () => {
    const shared = deviceTitles([MAC, MINI, BOX], { 'dev-mac': 'mini', 'dev-mini': 'Mini', 'dev-box': 'Build box' })
    expect(shared.get('dev-mac')).toBe('mini · 3F9A 21C4')
    expect(shared.get('dev-mini')).toBe('Mini · 81BC 77E0')
    expect(shared.get('dev-box')).toBe('Build box')
    // One was renamed: the keys go.
    expect(deviceTitles([MAC, MINI], { 'dev-mac': 'mini', 'dev-mini': 'Studio' }).get('dev-mac')).toBe('mini')
  })

  it('sets a right-to-left name apart, so the key after it keeps its order', () => {
    const shared = deviceTitles([MAC, MINI], { 'dev-mac': 'مكتب', 'dev-mini': 'مكتب' })
    expect(shared.get('dev-mac')).toBe('\u2068مكتب\u2069 · 3F9A 21C4')
  })
})

describe('savedServerTitle', () => {
  const names = { 'http://192.168.1.30:4082': 'office-nas' }
  it('prefers the name you gave, then the computer’s own, then the address', () => {
    expect(savedServerTitle({ base_url: 'http://192.168.1.30:4082/', name: 'Office NAS' }, names)).toBe('Office NAS')
    expect(savedServerTitle({ base_url: 'http://192.168.1.30:4082/', name: null }, names)).toBe('office-nas')
    expect(savedServerTitle({ base_url: 'http://192.168.1.31:4082', name: '  ' }, names)).toBe('http://192.168.1.31:4082')
  })
})

describe('formatBackendConnectionLabel with names', () => {
  it('names the account computer in use', () => {
    expect(formatBackendConnectionLabel(status({ account_device: MAC, computer_names: { 'dev-mac': 'Work' } }), '/api')).toBe('Work')
  })

  it('names an unnamed saved server by its computer, not its address', () => {
    const saved = status({ base_url: 'http://192.168.1.30:4082', servers: [{ base_url: 'http://192.168.1.30:4082', name: null }], computer_names: { 'http://192.168.1.30:4082': 'office-nas' } })
    expect(formatBackendConnectionLabel(saved, '/api')).toBe('office-nas')
    const named = status({ ...saved, servers: [{ base_url: 'http://192.168.1.30:4082', name: 'Office NAS' }] })
    expect(formatBackendConnectionLabel(named, '/api')).toBe('Office NAS')
  })
})

describe('computerNameKey', () => {
  it('is the device id on an account bridge, the address on any other server, and fixed for the built-in server', () => {
    expect(computerNameKey(status({ account_device: MAC }))).toBe('dev-mac')
    expect(computerNameKey(status({ base_url: 'http://192.168.1.30:4082/api/' }))).toBe('http://192.168.1.30:4082')
    expect(computerNameKey(status({ base_url: 'http://127.0.0.1:51000', mode: 'bundled', external: false }))).toBe('built-in')
    expect(computerNameKey(null)).toBeNull()
    expect(computerNameKey(status({ base_url: '' }))).toBeNull()
  })
})
