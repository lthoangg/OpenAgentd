/**
 * Typed reading of provider-usage responses and errors.
 *
 * The daemon answers a usage request with the snapshot, or with an error
 * whose `detail` is `{code, message, retry_at?, retry_after?, last_good?}`.
 * None of that is trusted as shaped: timing is bounded and finite, a
 * `last_good` snapshot is sanitised field by field, and UI copy never echoes
 * the server's message text.
 *
 * Deliberately free of runtime imports from `@/api/client`: errors are read by
 * shape (`status`, `detail`) so tests that stub the client still work.
 */
import { z } from 'zod'

import type { ProviderUsageLimit, ProviderUsageResponse } from '@/api/client'

/** The latest instant a JS `Date` can represent; timing past it is not a time at all. */
export const MAX_DATE_MS = 8.64e15
/** Cooldown assumed for a 429 that carries no usable retry time. */
export const DEFAULT_COOLDOWN_S = 60
/** A held snapshot older than this is not shown once a refresh has failed. */
export const STALE_MAX_MS = 30 * 60 * 1000
/** How far ahead of this clock a snapshot's stamp may be (clock skew) before it is not believed. */
const FUTURE_SKEW_MS = 5 * 60 * 1000

export type ProviderUsageErrorKind = 'rate_limited' | 'unsupported' | 'credentials' | 'rejected' | 'unavailable'

const KIND_BY_CODE: Record<string, ProviderUsageErrorKind> = {
  usage_rate_limited: 'rate_limited',
  usage_unsupported: 'unsupported',
  usage_credentials: 'credentials',
  usage_rejected: 'rejected',
  usage_unavailable: 'unavailable',
}

const MESSAGE: Record<ProviderUsageErrorKind, string> = {
  rate_limited: 'Usage is rate-limited.',
  unsupported: 'Usage is not available for this provider.',
  credentials: 'The provider needs a new sign-in.',
  rejected: 'The provider rejected the usage request.',
  unavailable: 'Usage is unavailable right now.',
}

export class ProviderUsageError extends Error {
  readonly kind: ProviderUsageErrorKind
  readonly status: number | null
  /** Client-clock time (ms) the provider can be asked again; rate-limited only. */
  readonly retryAtMs: number | null
  /** Last successful snapshot the daemon still held, if any. */
  readonly lastGood: ProviderUsageResponse | null

  constructor(kind: ProviderUsageErrorKind, init: { status?: number | null; retryAtMs?: number | null; lastGood?: ProviderUsageResponse | null } = {}) {
    super(MESSAGE[kind])
    this.name = 'ProviderUsageError'
    this.kind = kind
    this.status = init.status ?? null
    this.retryAtMs = init.retryAtMs ?? null
    this.lastGood = init.lastGood ?? null
  }
}

// ── Sanitising ───────────────────────────────────────────────────────────────

const num = z.number().nullish().catch(undefined)
const str = z.string().max(200).nullish().catch(undefined)
const windowSchema = z
  .object({ used_percent: z.number(), window_minutes: num, resets_at: num })
  .nullish()
  .catch(undefined)
const limitSchema = z.object({
  limit_id: str,
  limit_name: str,
  primary: windowSchema,
  secondary: windowSchema,
  credits: z
    .object({ has_credits: z.boolean().catch(false), unlimited: z.boolean().catch(false), balance: str })
    .nullish()
    .catch(undefined),
  spend: z
    .object({
      reached: z.boolean().catch(false),
      source: str,
      currency: str,
      limit: num,
      used: num,
      remaining: num,
      used_percent: num,
      resets_at: num,
    })
    .nullish()
    .catch(undefined),
  plan_type: str,
  rate_limit_reached_type: str,
  reset_credits_available: num,
  period_start_at: num,
  period_end_at: num,
})

const MAX_LIMITS = 50

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function finite(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined
}

function sanitizeLimits(raw: unknown): ProviderUsageLimit[] {
  if (!Array.isArray(raw)) return []
  const out: ProviderUsageLimit[] = []
  for (const item of raw.slice(0, MAX_LIMITS)) {
    const parsed = limitSchema.safeParse(item)
    if (parsed.success) out.push(parsed.data as ProviderUsageLimit)
  }
  return out
}

/** A unix-seconds stamp a `Date` can hold, or undefined. */
function epochSeconds(v: unknown): number | undefined {
  const s = finite(v)
  return s !== undefined && s > 0 && s * 1000 <= MAX_DATE_MS ? s : undefined
}

/**
 * A snapshot the daemon says it still holds. Its timestamp is required and
 * must be believable: without one it could only be shown as fresher than it is.
 */
function sanitizeSnapshot(raw: unknown, nowMs: number): ProviderUsageResponse | null {
  if (!isRecord(raw) || !Array.isArray(raw.limits)) return null
  const updated = epochSeconds(raw.updated_at)
  if (updated === undefined || updated * 1000 > nowMs + FUTURE_SKEW_MS) return null
  return {
    provider: typeof raw.provider === 'string' ? raw.provider.slice(0, 120) : '',
    limits: sanitizeLimits(raw.limits),
    updated_at: updated,
  }
}

/** A successful `/usage` body, reduced to the fields the UI reads. */
export function parseUsageResponse(raw: unknown): ProviderUsageResponse {
  const o = isRecord(raw) ? raw : {}
  const updated = epochSeconds(o.updated_at)
  return {
    provider: typeof o.provider === 'string' ? o.provider.slice(0, 120) : '',
    limits: sanitizeLimits(o.limits),
    ...(updated !== undefined ? { updated_at: updated } : {}),
  }
}

/** When a snapshot was taken: the daemon's stamp when it sent one, else when we received it. */
export function snapshotUpdatedAtMs(data: ProviderUsageResponse, receivedAtMs: number): number {
  const s = epochSeconds(data.updated_at)
  if (s === undefined) return receivedAtMs
  return Math.min(s * 1000, Date.now())
}

/** Older than the longest a held snapshot may be shown. */
export function isSnapshotExpired(updatedAtMs: number, nowMs: number = Date.now()): boolean {
  return nowMs - updatedAtMs > STALE_MAX_MS
}

/**
 * When to ask again. A valid wait is kept whole, however long (the daemon
 * honours it too); only timing a `Date` cannot represent is rejected, and
 * that falls back to a short default rather than being clamped. The relative
 * `retry_after` wins over the absolute `retry_at`, which a skewed clock would
 * move.
 */
function retryAtFrom(detail: Record<string, unknown> | null, nowMs: number): number {
  const after = finite(detail?.retry_after)
  if (after !== undefined && after > 0 && nowMs + after * 1000 <= MAX_DATE_MS) return nowMs + after * 1000
  const at = epochSeconds(detail?.retry_at)
  if (at !== undefined && at * 1000 > nowMs) return at * 1000
  return nowMs + DEFAULT_COOLDOWN_S * 1000
}

/** Any thrown value from a usage request, as a typed error. Never throws. */
export function toProviderUsageError(
  error: unknown,
  nowMs: number = Date.now(),
  /** `scoped`: the request named an account, so a bare 404 is that account missing, not the provider lacking usage. */
  context: { scoped?: boolean } = {},
): ProviderUsageError {
  if (error instanceof ProviderUsageError) return error
  const status = isRecord(error) || error instanceof Error ? finite((error as { status?: unknown }).status) ?? null : null
  const rawDetail = isRecord(error) || error instanceof Error ? (error as { detail?: unknown }).detail : undefined
  const detail = isRecord(rawDetail) ? rawDetail : null
  const code = typeof detail?.code === 'string' ? detail.code : null
  let kind: ProviderUsageErrorKind = (code && KIND_BY_CODE[code]) || 'unavailable'
  if (status === 429) kind = 'rate_limited'
  else if (!code || !KIND_BY_CODE[code]) {
    if (status === 401 || status === 403) kind = 'credentials'
    else if (status === 404 && !context.scoped) kind = 'unsupported'
  }
  return new ProviderUsageError(kind, {
    status,
    retryAtMs: kind === 'rate_limited' ? retryAtFrom(detail, nowMs) : null,
    lastGood: sanitizeSnapshot(detail?.last_good, nowMs),
  })
}

/** Milliseconds until the provider may be asked again; `0` when not cooling down. */
export function cooldownRemainingMs(error: unknown, nowMs: number = Date.now()): number {
  if (!(error instanceof ProviderUsageError) || error.kind !== 'rate_limited' || error.retryAtMs === null) return 0
  return Math.max(0, error.retryAtMs - nowMs)
}

/** `3m 08s`, `59s`, `1h 05m`. */
export function formatRetryIn(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  if (h > 0) return `${h}h ${String(m).padStart(2, '0')}m`
  if (m > 0) return `${m}m ${String(s % 60).padStart(2, '0')}s`
  return `${s}s`
}
