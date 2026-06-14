/**
 * Shared internals for the API client domain modules: the validation
 * error type and the response-detail parser used across every group.
 */

export class ApiValidationError extends Error {
  status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
    this.name = 'ApiValidationError'
  }
}

export async function parseDetailOrThrow(res: Response, label: string): Promise<never> {
  let detail = `${label} failed: ${res.status}`
  try {
    const body = await res.json()
    if (typeof body?.detail === 'string') detail = body.detail
    else if (Array.isArray(body?.detail)) detail = body.detail.map((e: { msg: string }) => e.msg).join('; ')
  } catch {
    // Non-JSON body — keep the fallback.
  }
  throw new ApiValidationError(res.status, detail)
}

// ── /agents ──────────────────────────────────────────────────────────────────
