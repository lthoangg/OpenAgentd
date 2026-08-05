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
  // Always keep a usable message: an empty `detail` string, an empty detail
  // array, or entries missing `msg` must not degrade the thrown error to `""`
  // or `"; "` — fall back to the labelled status instead. A non-string,
  // non-array `detail` (e.g. the `{reason, trace_id}` object some routes
  // return) also falls through to the label.
  const fallback = `${label} failed: ${res.status}`
  let detail = fallback
  try {
    const body = await res.json()
    if (typeof body?.detail === 'string') {
      detail = body.detail || fallback
    } else if (Array.isArray(body?.detail)) {
      const joined = body.detail
        .map((e: { msg?: string }) => e?.msg)
        .filter(Boolean)
        .join('; ')
      detail = joined || fallback
    }
  } catch {
    // Non-JSON body — keep the fallback.
  }
  throw new ApiValidationError(res.status, detail)
}

// ── /agents ──────────────────────────────────────────────────────────────────
