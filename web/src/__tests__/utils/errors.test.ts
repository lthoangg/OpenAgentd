import { describe, expect, it } from 'bun:test'

import { errorMessage, isTransientNetworkError } from '@/utils/errors'

describe('error utilities', () => {
  it('formats Error instances and unknown values consistently', () => {
    expect(errorMessage(new Error('failed'))).toBe('failed')
    expect(errorMessage('plain failure')).toBe('plain failure')
    expect(errorMessage(404)).toBe('404')
  })

  it('detects transient network failures across browser runtimes', () => {
    expect(isTransientNetworkError(new Error('Failed to fetch'))).toBe(true)
    expect(isTransientNetworkError(new Error('Load failed'))).toBe(true)
    expect(isTransientNetworkError(new Error('NetworkError when attempting to fetch resource.'))).toBe(true)
    expect(isTransientNetworkError('Network request failed')).toBe(true)
  })

  it('does not classify domain errors as transient network failures', () => {
    expect(isTransientNetworkError(new Error('Provider API key is missing'))).toBe(false)
  })
})
