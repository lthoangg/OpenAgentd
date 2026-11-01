/**
 * What a ``provider_status`` block says, read for the transcript's notices:
 * the account it names, and the plain-text details to copy.
 *
 * The server's status event carries no structured account field today: the
 * ``credential_label`` key is only stamped on answered messages. The pinned
 * wait and the account switch name their accounts inside ``message`` (a fixed
 * sentence built in ``agent/streaming.rs``), so those are read from it as a
 * fallback. A ``credential_label`` on the status itself wins when it exists.
 */
import type { ContentBlock } from '@/api/types'

type Extra = ContentBlock['extra']

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined
}

/** "{account} is pinned for this session and hit its usage limit. …" */
const PINNED_WAIT_RE = /^(.+?) is pinned for this session and hit its usage limit/
/** "{from} {reason}. Continuing on {to} with the same model." */
const SWITCHED_RE = /^(.*)\. Continuing on (.+?) with the same model\.?$/s

/** The account a quota wait is waiting on, when the status names it. */
export function waitAccount(extra: Extra | undefined): string | undefined {
  const labelled = text(extra?.credential_label)
  if (labelled) return labelled
  if (extra?.status !== 'waiting_credential') return undefined
  return PINNED_WAIT_RE.exec(text(extra.message) ?? '')?.[1]
}

/** The account a turn moved to when one hit its limit, and why the old one was left. */
export function switchedAccount(extra: Extra | undefined): { account?: string; reason?: string } {
  const message = text(extra?.message)
  const parsed = message ? SWITCHED_RE.exec(message) : null
  return {
    account: text(extra?.credential_label) ?? parsed?.[2],
    reason: parsed ? parsed[1] : message,
  }
}

/** An error's title, message, code, status and model as lines of plain text, for support. */
export function providerErrorDetails({ title, message, extra }: {
  title?: string
  message: string
  extra?: Extra
}): string {
  const fields: Array<[string, unknown]> = [
    ['Code', extra?.code],
    ['Type', extra?.error_type],
    ['Status', extra?.status_code],
    ['Model', extra?.model],
  ]
  const meta = fields
    .filter(([, value]) => value !== undefined && value !== null && value !== '')
    .map(([label, value]) => `${label}: ${String(value)}`)
  const head = title && title.trim() !== message.trim() ? [title, message] : [message]
  return [...head, ...meta].join('\n')
}
