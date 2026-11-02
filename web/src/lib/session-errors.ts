import { ApiValidationError } from '@/api/client/_shared'

/**
 * The session a URL names is not on the server: deleted (404), or not a
 * session id at all (422, e.g. a mistyped `/settngs`). A retry will not
 * find it, so the window says "Session not found" instead of spinning.
 */
export function isMissingSessionError(error: unknown): boolean {
  return error instanceof ApiValidationError && (error.status === 404 || error.status === 422)
}
