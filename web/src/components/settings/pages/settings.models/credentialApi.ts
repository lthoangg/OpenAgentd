/**
 * A read the shared client does not wrap yet: `POST
 * /settings/providers/{id}/models` with a `credential_id` lists the models
 * with that one credential's own values (never the one in use), which is
 * what Test on an account row needs.
 */
import { apiBaseUrl } from '@/api/base-url'
import { parseDetailOrThrow } from '@/api/client/_shared'

function credentialsUrl(providerId: string): string {
  return `${apiBaseUrl()}/settings/providers/${encodeURIComponent(providerId)}`
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
