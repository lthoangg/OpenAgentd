import { describe, expect, it } from 'bun:test'

import { deviceKindLabel, pendingLabel } from '@/api/phone-cloud'

describe('device kind labels', () => {
  it('names the kinds the API defines', () => {
    expect(deviceKindLabel('macos')).toBe('macOS')
    expect(deviceKindLabel('ios')).toBe('iOS')
    expect(deviceKindLabel(null)).toBeNull()
  })

  it('never shows a self-reported kind outside that set', () => {
    expect(deviceKindLabel('Your MacBook (verified)')).toBeNull()
    expect(deviceKindLabel('constructor')).toBeNull()
  })

  it('shows a pending request with its kind', () => {
    const row = { enrollment_id: 'e', fingerprint: '9C02 E1B7', country: null, created_at: null, expires_at: null, kind: 'linux' }
    expect(pendingLabel(row)).toBe('Linux · 9C02 E1B7')
  })
})
