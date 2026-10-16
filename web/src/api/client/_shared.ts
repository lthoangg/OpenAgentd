/**
 * Shared internals for the API client domain modules: the validation
 * error type and the response-detail parser used across every group.
 */

export class ApiValidationError extends Error {
  status: number
  /** The response's raw `detail` (string, validation array, or object). */
  detail: unknown
  constructor(status: number, message: string, detail?: unknown) {
    super(message)
    this.status = status
    this.detail = detail
    this.name = 'ApiValidationError'
  }
}

export async function parseDetailOrThrow(res: Response, label: string): Promise<never> {
  // Always keep a usable message: an empty `detail` string, an empty detail
  // array, or entries missing `msg` must not degrade the thrown error to `""`
  // or `"; "` — fall back to the labelled status instead. An object `detail`
  // (e.g. `{reason, trace_id}`) uses its `message` when present, else the
  // label; the raw value stays on `error.detail` either way.
  const fallback = `${label} failed: ${res.status}`
  let detail = fallback
  let raw: unknown
  try {
    const body = await res.json()
    raw = body?.detail
    if (typeof body?.detail === 'string') {
      detail = body.detail || fallback
    } else if (Array.isArray(body?.detail)) {
      const joined = body.detail
        .map((e: { msg?: string }) => e?.msg)
        .filter(Boolean)
        .join('; ')
      detail = joined || fallback
    } else if (body?.detail && typeof body.detail === 'object' && typeof body.detail.message === 'string') {
      detail = body.detail.message || fallback
    }
  } catch {
    // Non-JSON body — keep the fallback.
  }
  throw new ApiValidationError(res.status, detail, raw)
}

// ── /agents ──────────────────────────────────────────────────────────────────

/** Last `{etag, data}` per URL for {@link fetchJsonWithEtag}; least recent first. */
const etagCache = new Map<string, { etag: string; data: unknown }>()
const MAX_ETAG_ENTRIES = 64

/**
 * GET JSON with `If-None-Match` revalidation. The server answers `304` with
 * no body while the result is unchanged, and this returns the **same object**
 * it returned last time, so TanStack Query's structural sharing keeps every
 * consumer's reference and nothing re-renders. Used for the listings and git
 * reads that are refetched after every agent tool call.
 */
export async function fetchJsonWithEtag<T>(url: string, label: string, signal?: AbortSignal): Promise<T> {
  const cached = etagCache.get(url)
  const res = await fetch(url, {
    signal,
    // The page owns revalidation; keep the HTTP cache out of the way.
    cache: 'no-store',
    ...(cached ? { headers: { 'If-None-Match': cached.etag } } : {}),
  })
  if (res.status === 304 && cached) {
    etagCache.delete(url)
    etagCache.set(url, cached)
    return cached.data as T
  }
  if (!res.ok) await parseDetailOrThrow(res, label)
  const data = (await res.json()) as T
  const etag = res.headers?.get?.('ETag')
  etagCache.delete(url)
  if (etag) {
    etagCache.set(url, { etag, data })
    while (etagCache.size > MAX_ETAG_ENTRIES) {
      const oldest = etagCache.keys().next()
      if (oldest.done) break
      etagCache.delete(oldest.value)
    }
  }
  return data
}

/** Test seam. */
export function clearEtagCache(): void {
  etagCache.clear()
}
