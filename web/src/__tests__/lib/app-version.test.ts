import { describe, expect, it } from 'bun:test'

import { versionSkew } from '@/lib/app-version'

describe('versionSkew', () => {
  it('is unknown when either side is missing or unparsable', () => {
    expect(versionSkew(undefined, '1.2.3')).toEqual({ kind: 'unknown' })
    expect(versionSkew('1.2.3', 'dev')).toEqual({ kind: 'unknown' })
  })

  it('treats equal versions (with or without v) as the same', () => {
    expect(versionSkew('v3.49.0', '3.49.0')).toEqual({ kind: 'same' })
  })

  it('separates patch from major/minor differences and names the newer side', () => {
    expect(versionSkew('3.49.1', '3.49.0')).toEqual({ kind: 'patch', newer: 'client' })
    expect(versionSkew('3.48.9', '3.49.0')).toEqual({ kind: 'major-minor', newer: 'server' })
    expect(versionSkew('4.0.0', '3.99.99')).toEqual({ kind: 'major-minor', newer: 'client' })
  })

  it('compares numerically, not as strings', () => {
    expect(versionSkew('3.10.0', '3.9.0')).toEqual({ kind: 'major-minor', newer: 'client' })
  })
})
