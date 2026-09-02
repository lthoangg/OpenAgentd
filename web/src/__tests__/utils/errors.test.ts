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

  it('does not mistake digits or words embedded in other messages for gateway errors', () => {
    expect(isTransientNetworkError(new Error('context window exceeded: 5030 tokens'))).toBe(false)
    expect(isTransientNetworkError(new Error('port 5200 already in use'))).toBe(false)
    expect(isTransientNetworkError(new Error('Session 15031 was archived'))).toBe(false)
    expect(isTransientNetworkError(new Error('The operation was aborted by the user'))).toBe(false)
    expect(isTransientNetworkError(new Error('Tool aborted: file too large'))).toBe(false)
    expect(isTransientNetworkError(new Error('Model timeout setting must be a number'))).toBe(false)
  })

  it('still treats real gateway status lines and request timeouts as transient', () => {
    expect(isTransientNetworkError(new Error('HTTP 520'))).toBe(true)
    expect(isTransientNetworkError(new Error('Request timed out after 30s'))).toBe(true)
    expect(isTransientNetworkError(new Error('The request timed out'))).toBe(true)
  })
})
