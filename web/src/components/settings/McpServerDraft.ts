/**
 * Editable draft model for an MCP server.
 *
 * Lives in a sibling file (not in `McpServerForm.tsx`) so the form module
 * can stay component-only — required for Vite's fast-refresh contract.
 *
 * Both transports' fields are kept in the draft so flipping the
 * transport tab doesn't lose what the user typed in the other one;
 * `draftToServerBody` serialises only the active branch when sending.
 */
import type { ServerBody } from '@/api/client'

export interface KeyValuePair {
  key: string
  value: string
}

export interface McpServerDraft {
  name: string
  transport: 'stdio' | 'http'
  enabled: boolean
  /** Tool-call timeout in seconds as typed; empty = server default. */
  timeoutText: string
  // stdio
  command: string
  argsText: string
  envPairs: KeyValuePair[]
  // http
  url: string
  headerPairs: KeyValuePair[]
  oauthEnabled: boolean
  oauthClientIdEnv: string
  oauthClientSecretEnv: string
}

/** Server name format — matches the backend regex (see `app/agent/mcp/config.py`). */
export const SERVER_NAME_REGEX = /^[a-zA-Z][a-zA-Z0-9_-]*$/

export function emptyDraft(): McpServerDraft {
  return {
    name: '',
    transport: 'stdio',
    enabled: true,
    timeoutText: '',
    command: '',
    argsText: '',
    envPairs: [],
    url: '',
    headerPairs: [],
    oauthEnabled: false,
    oauthClientIdEnv: '',
    oauthClientSecretEnv: '',
  }
}

/** Hydrate a draft from a backend `ServerBody` payload (edit mode seed). */
export function draftFromServerBody(name: string, body: ServerBody): McpServerDraft {
  if (body.transport === 'stdio') {
    return {
      name,
      transport: 'stdio',
      enabled: body.enabled,
      timeoutText: body.timeout != null ? String(body.timeout) : '',
      command: body.command,
      argsText: body.args.join('\n'),
      envPairs: Object.entries(body.env).map(([key, value]) => ({ key, value })),
      url: '',
      headerPairs: [],
      oauthEnabled: false,
      oauthClientIdEnv: '',
      oauthClientSecretEnv: '',
    }
  }
  return {
    name,
    transport: 'http',
    enabled: body.enabled,
    timeoutText: body.timeout != null ? String(body.timeout) : '',
    command: '',
    argsText: '',
    envPairs: [],
    url: body.url,
    headerPairs: Object.entries(body.headers).map(([key, value]) => ({ key, value })),
    oauthEnabled: !!body.oauth,
    oauthClientIdEnv: body.oauth?.client_id ?? '',
    oauthClientSecretEnv: body.oauth?.client_secret ?? '',
  }
}

/**
 * Serialise a draft to the discriminated `ServerBody` the API expects.
 * Returns `{ ok: false, error }` when the active branch's required
 * fields are missing — callers use this for the final pre-flight check
 * after the form-level validators have already run.
 */
export function draftToServerBody(
  draft: McpServerDraft,
): { ok: true; body: ServerBody } | { ok: false; error: string } {
  if (draft.transport === 'stdio') {
    if (!draft.command.trim()) {
      return { ok: false, error: 'Command is required for stdio servers.' }
    }
    return {
      ok: true,
      body: {
        transport: 'stdio',
        command: draft.command.trim(),
        args: draft.argsText
          .split('\n')
          .map((s) => s.trim())
          .filter(Boolean),
        env: pairsToRecord(draft.envPairs),
        enabled: draft.enabled,
        ...timeoutField(draft),
      },
    }
  }
  if (!draft.url.trim()) {
    return { ok: false, error: 'URL is required for HTTP servers.' }
  }
  return {
    ok: true,
    body: {
      transport: 'http',
      url: draft.url.trim(),
      headers: pairsToRecord(draft.headerPairs),
      oauth: draft.oauthEnabled
        ? {
            client_id: draft.oauthClientIdEnv.trim() || null,
            client_secret: draft.oauthClientSecretEnv.trim() || null,
          }
        : null,
      enabled: draft.enabled,
      ...timeoutField(draft),
    },
  }
}

/** Largest tool-call timeout the backend accepts, in seconds. */
export const MAX_MCP_TIMEOUT_S = 270

function timeoutField(draft: McpServerDraft): { timeout?: number } {
  const t = draft.timeoutText.trim()
  return t ? { timeout: Number(t) } : {}
}

function pairsToRecord(pairs: KeyValuePair[]): Record<string, string> {
  return Object.fromEntries(pairs.filter((p) => p.key.trim()).map((p) => [p.key, p.value]))
}

/**
 * Single-pass validation matching the backend rules. Returns a map of
 * field → message for every failing field; returns null when the draft
 * is acceptable. Empty key/value pairs are silently dropped on
 * serialisation, so they are not flagged here.
 */
export function validateDraft(
  draft: McpServerDraft,
  opts: { isNew: boolean },
): Record<string, string> | null {
  const errors: Record<string, string> = {}

  if (opts.isNew) {
    if (!draft.name.trim()) {
      errors.name = 'Name is required.'
    } else if (!SERVER_NAME_REGEX.test(draft.name)) {
      errors.name =
        'Name must start with a letter and contain only letters, digits, _ or -.'
    }
  }

  if (draft.transport === 'stdio') {
    if (!draft.command.trim()) errors.command = 'Command is required.'
  } else if (!draft.url.trim()) {
    errors.url = 'URL is required.'
  }

  const t = draft.timeoutText.trim()
  if (t && (!/^\d+$/.test(t) || Number(t) < 1 || Number(t) > MAX_MCP_TIMEOUT_S)) {
    errors.timeout = `Timeout must be a whole number of seconds from 1 to ${MAX_MCP_TIMEOUT_S}.`
  }

  // Reject duplicate keys — they would be silently collapsed by
  // Object.fromEntries during serialisation.
  const dupEnv = findDuplicateKey(draft.envPairs)
  if (dupEnv) errors.env = `Duplicate environment variable: ${dupEnv}`
  const dupHdr = findDuplicateKey(draft.headerPairs)
  if (dupHdr) errors.headers = `Duplicate header: ${dupHdr}`

  return Object.keys(errors).length === 0 ? null : errors
}

function findDuplicateKey(pairs: KeyValuePair[]): string | null {
  const seen = new Set<string>()
  for (const p of pairs) {
    const k = p.key.trim()
    if (!k) continue
    if (seen.has(k)) return k
    seen.add(k)
  }
  return null
}

/** Structural draft equality — the route uses this to compute `dirty`. */
export function draftEquals(a: McpServerDraft, b: McpServerDraft): boolean {
  if (a.name !== b.name || a.transport !== b.transport || a.enabled !== b.enabled || a.timeoutText !== b.timeoutText) {
    return false
  }
  if (a.transport === 'stdio') {
    if (a.command !== b.command || a.argsText !== b.argsText) return false
    return pairsEqual(a.envPairs, b.envPairs)
  }
  if (a.url !== b.url) return false
  return (
    pairsEqual(a.headerPairs, b.headerPairs) &&
    a.oauthEnabled === b.oauthEnabled &&
    a.oauthClientIdEnv === b.oauthClientIdEnv &&
    a.oauthClientSecretEnv === b.oauthClientSecretEnv
  )
}

function pairsEqual(a: KeyValuePair[], b: KeyValuePair[]): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) {
    if (a[i].key !== b[i].key || a[i].value !== b[i].value) return false
  }
  return true
}
