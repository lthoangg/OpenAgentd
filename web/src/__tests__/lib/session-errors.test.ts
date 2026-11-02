import { describe, expect, it } from 'bun:test'

import { ApiValidationError } from '@/api/client/_shared'
import { isMissingSessionError } from '@/lib/session-errors'

describe('isMissingSessionError', () => {
  it('reads a 404 and an id the server rejects (422) as a session that is not there', () => {
    expect(isMissingSessionError(new ApiValidationError(404, 'Session not found.'))).toBe(true)
    expect(isMissingSessionError(new ApiValidationError(422, 'Input should be a valid UUID'))).toBe(true)
  })

  it('leaves server and network failures to be retried', () => {
    expect(isMissingSessionError(new ApiValidationError(500, 'boom'))).toBe(false)
    expect(isMissingSessionError(new TypeError('Failed to fetch'))).toBe(false)
    expect(isMissingSessionError(null)).toBe(false)
  })
})
