/**
 * Two reads of one provider's credentials that the shared client does not
 * wrap yet, both already served by the daemon:
 *
 * - `GET /settings/providers/{id}/credentials` carries `pinned_sessions` per
 *   credential (how many sessions are pinned to it). The provider list's
 *   `stored_credentials` does not, so the Providers page asks for it here.
 * - `POST /settings/providers/{id}/models` with a `credential_id` lists the
 *   models with that one credential's own values (never the one in use),
 *   which is what Test on an account row needs.
 */
import { useQuery } from '@tanstack/react-query'

import { apiBaseUrl } from '@/api/base-url'
import { parseDetailOrThrow } from '@/api/client/_shared'
import { queryKeys } from '@/queries/keys'

function credentialsUrl(providerId: string): string {
  return `${apiBaseUrl()}/settings/providers/${encodeURIComponent(providerId)}`
}

/** Sessions pinned to each of a provider's credentials, by credential id. */
export async function fetchPinnedSessionCounts(providerId: string): Promise<Record<string, number>> {
  const res = await fetch(`${credentialsUrl(providerId)}/credentials`)
  if (!res.ok) await parseDetailOrThrow(res, `GET /settings/providers/${providerId}/credentials`)
  const body = (await res.json()) as { credentials?: Array<{ id: string; pinned_sessions?: number }> }
  return Object.fromEntries((body.credentials ?? []).map((c) => [c.id, c.pinned_sessions ?? 0]))
}

/**
 * `pinned_sessions` for each credential of `providerId`, empty until it
 * arrives (or when the daemon is older and does not report it). Sits under
 * the providers key, so any credential change refreshes it.
 */
export function usePinnedSessionCounts(providerId: string, enabled: boolean): Record<string, number> {
  const query = useQuery({
    queryKey: [...queryKeys.settings.providers(), providerId, 'credentials'],
    queryFn: () => fetchPinnedSessionCounts(providerId),
    enabled,
    retry: false,
    staleTime: 15_000,
  })
  return query.data ?? {}
}

/** Models one credential can list: it works when this returns at least one. */
export async function testCredential(providerId: string, credentialId: string): Promise<{ models: string[] }> {
  const res = await fetch(`${credentialsUrl(providerId)}/models`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ credential_id: credentialId }),
  })
  if (!res.ok) await parseDetailOrThrow(res, `POST /settings/providers/${providerId}/models`)
  const body = (await res.json()) as { models?: string[] }
  return { models: body.models ?? [] }
}
