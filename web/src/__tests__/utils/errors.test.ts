import { describe, it, expect } from 'bun:test'
import { errorMessage, isTransientNetworkError } from '@/utils/errors'

describe('errors utility', () => {
  it('extracts error messages from Error and string inputs', () => {
    expect(errorMessage(new Error('something broke'))).toBe('something broke')
    expect(errorMessage('plain string error')).toBe('plain string error')
    expect(errorMessage(null)).toBe('null')
  })

  it('detects standard browser and fetch network errors as transient', () => {
    expect(isTransientNetworkError(new Error('Failed to fetch'))).toBe(true)
    expect(isTransientNetworkError(new Error('TypeError: Load failed'))).toBe(true)
    expect(isTransientNetworkError(new Error('NetworkError when attempting to fetch resource.'))).toBe(true)
    expect(isTransientNetworkError(new Error('Network request failed'))).toBe(true)
  })

  it('detects network disconnect and connection reset/refused errors as transient', () => {
    expect(isTransientNetworkError(new Error('net::ERR_CONNECTION_RESET'))).toBe(true)
    expect(isTransientNetworkError(new Error('net::ERR_INTERNET_DISCONNECTED'))).toBe(true)
    expect(isTransientNetworkError(new Error('net::ERR_NAME_NOT_RESOLVED'))).toBe(true)
    expect(isTransientNetworkError(new Error('net::ERR_CONNECTION_REFUSED'))).toBe(true)
    expect(isTransientNetworkError(new Error('net::ERR_NETWORK_CHANGED'))).toBe(true)
    expect(isTransientNetworkError(new Error('connect ECONNREFUSED 127.0.0.1:8000'))).toBe(true)
    expect(isTransientNetworkError(new Error('read ECONNRESET'))).toBe(true)
    expect(isTransientNetworkError(new Error('ETIMEDOUT'))).toBe(true)
    expect(isTransientNetworkError(new Error('socket hang up'))).toBe(true)
  })

  it('detects temporary 502/503/504 gateway errors as transient', () => {
    expect(isTransientNetworkError(new Error('GET /api/agent/stream failed: 502'))).toBe(true)
    expect(isTransientNetworkError(new Error('503 Service Unavailable'))).toBe(true)
    expect(isTransientNetworkError(new Error('504 Gateway Timeout'))).toBe(true)
  })

  it('returns false for non-transient domain errors', () => {
    expect(isTransientNetworkError(new Error('Session not found'))).toBe(false)
    expect(isTransientNetworkError(new Error('Invalid tool argument: path required'))).toBe(false)
    expect(isTransientNetworkError(new Error('Model not supported'))).toBe(false)
  })
})
