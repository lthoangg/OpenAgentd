/**
 * Secrets the user gives the agent (`/api/secrets`) and the answer to a
 * secret card. {@link saveSecret} is the only call that carries a value.
 */
import { apiBaseUrl } from '../base-url'
import { parseDetailOrThrow } from './_shared'
import type { QuestionResolveResult, SecretAnswer, SecretsListResponse } from '../question-types'

/** Every saved value, names and projects only; ``workspace`` adds that folder's project and usable names. */
export async function listSecrets(workspace?: string): Promise<SecretsListResponse> {
  const q = workspace ? `?workspace=${encodeURIComponent(workspace)}` : ''
  const res = await fetch(`${apiBaseUrl()}/secrets${q}`)
  if (!res.ok) await parseDetailOrThrow(res, 'GET /secrets')
  return res.json()
}

/**
 * Save a new value of ``name`` (``value`` and ``projects``), or edit value
 * ``id`` (a new ``value``, new ``projects``, or both). ``projects`` holds
 * project keys or folders, or ``'*'`` for every project. The only call that
 * carries a secret's value; the response never does.
 */
export async function saveSecret(
  name: string,
  body: { value?: string; projects?: string[]; id?: string; source?: 'chat' | 'settings' },
): Promise<{ name: string; id: string }> {
  const res = await fetch(`${apiBaseUrl()}/secrets/${encodeURIComponent(name)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!res.ok) await parseDetailOrThrow(res, 'PUT /secrets')
  return res.json()
}

export async function deleteSecret(name: string, id: string): Promise<void> {
  const res = await fetch(`${apiBaseUrl()}/secrets/${encodeURIComponent(name)}/${encodeURIComponent(id)}`, { method: 'DELETE' })
  if (!res.ok) await parseDetailOrThrow(res, 'DELETE /secrets')
}

/**
 * Answer a secret card. The body names keys and choices only: each value
 * goes to {@link saveSecret} first, never through this call.
 */
export async function answerSecretRequest(sessionId: string, questionId: string, secret: SecretAnswer): Promise<QuestionResolveResult> {
  const res = await fetch(
    `${apiBaseUrl()}/agent/${encodeURIComponent(sessionId)}/question/${encodeURIComponent(questionId)}/answer`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ secret }),
    },
  )
  if (!res.ok) await parseDetailOrThrow(res, 'answerSecretRequest')
  return res.json()
}
