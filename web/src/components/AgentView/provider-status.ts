/**
 * What a ``provider_status`` block says, read for the transcript's notices:
 * the account it names, the plain-text details to copy, which kind of row it
 * is (an error card, a bare "retries ran out" line), and whether it is still
 * the turn's last word (blank ``thinking``/``text`` chunks after it say nothing).
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

/**
 * An error's title, message, code, status and model as lines of plain text,
 * for support. The transport's own text (``details``: the URL, the status
 * line) comes last; the card never shows it.
 */
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
  const raw = text(extra?.details)
  return [...head, ...meta, ...(raw ? [raw] : [])].join('\n')
}

/**
 * The server's "retries ran out" mark: the model and the budget, but no
 * message. The error the turn ends with follows it and is the card; this is
 * the one line under the retries saying they stopped.
 */
export function isBareExhausted(block: ContentBlock): boolean {
  return block.type === 'provider_status' && block.extra?.status === 'exhausted' &&
    !block.content && !(typeof block.extra?.message === 'string' && block.extra.message)
}

export function isProviderErrorBlock(block: ContentBlock): boolean {
  if (block.type !== 'provider_status') return false
  if (isBareExhausted(block)) return false
  const status = block.extra?.status
  return status === 'error' || status === 'exhausted' || block.extra?.category === 'provider'
}

/** The provider error a turn ended on, if it ended on one. */
export function endingProviderError(blocks: ContentBlock[]): ContentBlock | undefined {
  for (let i = blocks.length - 1; i >= 0; i--) {
    if (isBlankContentBlock(blocks[i])) continue
    return isProviderErrorBlock(blocks[i]) ? blocks[i] : undefined
  }
  return undefined
}

/** True for a `thinking`/`text` block that has streamed in only whitespace
 *  so far (e.g. a provider's blank reasoning-section separator, or the
 *  very first chunk before real content arrives). Such a block renders no
 *  visible output, so it must not count as "content has started" when
 *  deciding whether to keep showing the pending dots — otherwise the user
 *  is left staring at a blank chat area with no dots and no content. */
export function isBlankContentBlock(block: ContentBlock): boolean {
  return (block.type === 'thinking' || block.type === 'text') && block.content.trim().length === 0
}

/**
 * The retry notice still waiting on its call: the last thing the turn said.
 * Anything after it (the answer starting, an error card) means the retry is
 * over, so the notice goes.
 */
export function latestActiveRetryBlockId(finalizedBlocks: ContentBlock[], liveBlocks: ContentBlock[]): string | undefined {
  for (const part of [liveBlocks, finalizedBlocks]) {
    for (let index = part.length - 1; index >= 0; index -= 1) {
      const block = part[index]
      if (isBlankContentBlock(block)) continue
      return block.type === 'provider_status' && block.extra?.status === 'retrying' ? block.id : undefined
    }
  }
  return undefined
}
