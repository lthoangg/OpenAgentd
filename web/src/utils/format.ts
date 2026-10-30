/**
 * Me check if content ends with a sleep sentinel.
 * Returns the text before the sentinel (may be empty), or null if not present.
 */
export function extractSleepPrefix(content: string): string | null {
  const trimmed = content.trimEnd()
  if (trimmed.endsWith('<sleep>')) return trimmed.slice(0, -'<sleep>'.length).trimEnd()
  if (trimmed.endsWith('[sleep]')) return trimmed.slice(0, -'[sleep]'.length).trimEnd()
  return null
}

/** Me check if content ends with a sleep sentinel */
export function isSleepMessage(content: string): boolean {
  return extractSleepPrefix(content) !== null
}

export function shortId(id: string): string {
  return id.slice(0, 8)
}

/** Model families whose name a provider sometimes prefixes with its own. */
const MODEL_FAMILY = /-(?=(?:claude|gpt|gemini|grok|llama|qwen|deepseek|mistral|kimi|glm|minimax|o\d)[-\w.]*$)/

/**
 * ``provider:vendor/model`` → ``{ provider, short }``. ``short`` drops the
 * vendor path and a provider prefix repeated in the name
 * (``agy:antigravity-claude-sonnet-4-6`` → ``claude-sonnet-4-6``, ``agy``),
 * so the UI shows the ID a user would type, with the provider as a tag.
 */
export function modelParts(modelId: string): { provider: string | null; short: string } {
  const colon = modelId.indexOf(':')
  const provider = colon > 0 ? modelId.slice(0, colon) : null
  let name = (colon > 0 ? modelId.slice(colon + 1) : modelId).split('/').at(-1) || modelId
  const family = name.search(MODEL_FAMILY)
  if (family > 0) name = name.slice(family + 1)
  return { provider, short: name }
}

/** ``provider:vendor/model`` → ``model`` (see ``modelParts``). */
export function shortModelName(modelId: string | null | undefined): string | null {
  if (!modelId) return null
  return modelParts(modelId).short
}

// Building an ``Intl`` formatter costs far more than using one, and the
// transcript formats a time per message on every render. Build each once.
let timeFormatter: Intl.DateTimeFormat | undefined

export function formatTime(date: Date): string {
  timeFormatter ??= new Intl.DateTimeFormat(undefined, {
    hour: 'numeric',
    minute: '2-digit',
    hour12: false,
  })
  return timeFormatter.format(date)
}

/**
 * Me format a full date+time as "dd/MM/yyyy HH:mm:ss" — used anywhere a
 * precise absolute timestamp is shown (e.g. tooltips), so it never falls
 * back to the browser locale's (often MM/DD/YYYY) rendering.
 */
export function formatFullDateTime(date: Date): string {
  return format(date, 'dd/MM/yyyy HH:mm:ss')
}

export function formatTokens(n: number): string {
  if (n >= 1000) {
    return (n / 1000).toFixed(1).replace(/\.0$/, '') + 'k'
  }
  return String(n)
}

/** Human-readable byte size — "523 B", "12.4 KB", "3.1 MB". */
export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1).replace(/\.0$/, '')} KB`
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1).replace(/\.0$/, '')} MB`
  return `${(n / (1024 * 1024 * 1024)).toFixed(1).replace(/\.0$/, '')} GB`
}

export function formatDate(dateStr: string | null): Date {
  if (!dateStr) return new Date()
  return new Date(dateStr)
}

import { isToday, isYesterday, isSameDay, format } from 'date-fns'

// Me format date+time: "Today 14:32", "Yesterday 09:01", or "DD/MM/YYYY 14:32"
export function formatRelativeDate(dateStr: string | null): string {
  if (!dateStr) return ''
  const date = new Date(dateStr)
  const time = format(date, 'HH:mm')
  if (isToday(date)) return `Today ${time}`
  if (isYesterday(date)) return `Yesterday ${time}`
  return `${format(date, 'dd/MM/yyyy')} ${time}`
}

/**
 * Compact age for dense list meta slots: ``now``, ``5m``, ``3h``, ``2d``,
 * then ``dd/MM`` past a week. Future timestamps (clock skew) read ``now``.
 */
export function formatCompactRelative(dateStr: string | null | undefined, now: Date = new Date()): string {
  if (!dateStr) return ''
  const date = new Date(dateStr)
  const elapsed = now.getTime() - date.getTime()
  if (!Number.isFinite(elapsed)) return ''
  const minutes = Math.floor(elapsed / 60_000)
  if (minutes < 1) return 'now'
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h`
  const days = Math.floor(hours / 24)
  if (days < 7) return `${days}d`
  return format(date, 'dd/MM')
}

/**
 * Compact next-fire time for dense list meta slots: ``HH:mm`` later today,
 * ``EEE HH:mm`` within a week, then ``dd/MM``. Past times read ``due``.
 */
export function formatCompactUpcoming(dateStr: string | null | undefined, now: Date = new Date()): string {
  if (!dateStr) return ''
  const date = new Date(dateStr)
  const ahead = date.getTime() - now.getTime()
  if (!Number.isFinite(ahead)) return ''
  if (ahead <= 0) return 'due'
  if (isSameDay(date, now)) return format(date, 'HH:mm')
  if (ahead < 7 * 24 * 60 * 60_000) return format(date, 'EEE HH:mm')
  return format(date, 'dd/MM')
}

// ── IANA timezone helpers ────────────────────────────────────────────────────
//
// The browser's `Intl` API can both render a given UTC instant in any IANA
// zone and tell us the UTC offset of that zone at any instant. We avoid
// pulling in `date-fns-tz` for two small helpers.

type ZoneFormatterKind = 'offset' | 'wallClock' | 'display'

const ZONE_FORMAT_OPTIONS: Record<ZoneFormatterKind, { locale: string; options: Intl.DateTimeFormatOptions }> = {
  offset: {
    locale: 'en-US',
    options: {
      hourCycle: 'h23',
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    },
  },
  wallClock: {
    locale: 'en-US',
    options: {
      hourCycle: 'h23',
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit',
    },
  },
  display: {
    locale: 'en-GB',
    options: {
      hourCycle: 'h23',
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit',
    },
  },
}

const zoneFormatters = new Map<string, Intl.DateTimeFormat>()

/** One formatter per (kind, zone). Throws for an unknown zone, never caching it. */
function zoneFormatter(kind: ZoneFormatterKind, timeZone: string): Intl.DateTimeFormat {
  const key = `${kind}\u0000${timeZone}`
  let formatter = zoneFormatters.get(key)
  if (!formatter) {
    const { locale, options } = ZONE_FORMAT_OPTIONS[kind]
    formatter = new Intl.DateTimeFormat(locale, { ...options, timeZone })
    zoneFormatters.set(key, formatter)
  }
  return formatter
}

/**
 * Me get the offset (in minutes, east-of-UTC) that the IANA `timeZone` was
 * at the given UTC instant. e.g. `Asia/Ho_Chi_Minh` → 420 always;
 * `America/New_York` → -300 (EST) or -240 (EDT) depending on the date.
 *
 * Returns 0 (UTC) for unknown zones rather than throwing.
 */
export function getTimezoneOffsetMinutes(timeZone: string, instant: Date): number {
  try {
    const parts = zoneFormatter('offset', timeZone).formatToParts(instant)
    const map: Record<string, string> = {}
    for (const p of parts) if (p.type !== 'literal') map[p.type] = p.value
    const asUTC = Date.UTC(
      Number(map.year), Number(map.month) - 1, Number(map.day),
      Number(map.hour), Number(map.minute), Number(map.second),
    )
    return Math.round((asUTC - instant.getTime()) / 60000)
  } catch {
    return 0
  }
}

/**
 * Me convert a naive local-wall-clock string ("yyyy-MM-dd'T'HH:mm") that
 * the user picked while thinking in `timeZone` into a tz-aware ISO-8601
 * string the backend can store unambiguously.
 *
 * Returns the input unchanged if it's empty or already has an offset/Z.
 */
export function wallClockToISO(local: string, timeZone: string): string {
  if (!local) return local
  // Already aware? Pass through.
  if (/[zZ]|[+-]\d{2}:?\d{2}$/.test(local)) return local

  // Parse the wall-clock fields directly — do NOT use `new Date(local)`
  // because that would interpret them in the browser's zone.
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(local)
  if (!m) return local
  const [, y, mo, d, h, mi, s = '00'] = m

  // Find the offset of `timeZone` at this wall-clock. We do one round-trip:
  // pretend the wall-clock is UTC, ask what offset the zone has at that
  // instant, then subtract. (DST edges can drift by an hour; one fixup
  // iteration is enough for any IANA zone.)
  const utcGuess = Date.UTC(+y, +mo - 1, +d, +h, +mi, +s)
  const initialOffset = getTimezoneOffsetMinutes(timeZone, new Date(utcGuess))
  const initialInstant = utcGuess - initialOffset * 60_000
  const offset = getTimezoneOffsetMinutes(timeZone, new Date(initialInstant))

  const sign = offset >= 0 ? '+' : '-'
  const abs = Math.abs(offset)
  const oh = String(Math.floor(abs / 60)).padStart(2, '0')
  const om = String(abs % 60).padStart(2, '0')
  return `${y}-${mo}-${d}T${h}:${mi}:${s}${sign}${oh}:${om}`
}

/**
 * Me convert a tz-aware ISO-8601 string from the API back to a naive
 * wall-clock string ("yyyy-MM-dd'T'HH:mm") in the supplied `timeZone`.
 * Useful for seeding form pickers that expect local-style input.
 */
export function isoToWallClock(iso: string, timeZone: string): string {
  if (!iso) return ''
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return ''
  try {
    const parts = zoneFormatter('wallClock', timeZone).formatToParts(date)
    const map: Record<string, string> = {}
    for (const p of parts) if (p.type !== 'literal') map[p.type] = p.value
    return `${map.year}-${map.month}-${map.day}T${map.hour}:${map.minute}`
  } catch {
    return ''
  }
}

/**
 * Me format a tz-aware ISO-8601 string in the supplied IANA `timeZone`
 * as "dd/MM/yyyy HH:mm". Falls back to browser-local rendering if the
 * zone is unknown.
 */
export function formatInTimezone(iso: string | null | undefined, timeZone: string): string {
  if (!iso) return ''
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return ''
  try {
    const parts = zoneFormatter('display', timeZone).formatToParts(date)
    const map: Record<string, string> = {}
    for (const p of parts) if (p.type !== 'literal') map[p.type] = p.value
    return `${map.day}/${map.month}/${map.year} ${map.hour}:${map.minute}`
  } catch {
    return format(date, 'dd/MM/yyyy HH:mm')
  }
}

import type { ContentBlock } from '@/api/types'

/**
 * The text blocks that make up a turn's final answer: prose after the turn's
 * last tool call. Earlier text is narration between tool calls. Blocks that
 * are blank or hold nothing but a sleep sentinel are left out.
 */
export function finalAnswerBlocks(turn: ContentBlock[]): ContentBlock[] {
  let start = 0
  for (let i = turn.length - 1; i >= 0; i--) {
    if (turn[i].type === 'tool') {
      start = i + 1
      break
    }
  }
  return turn.slice(start).filter((block) => {
    if (block.type !== 'text') return false
    const content = extractSleepPrefix(block.content) ?? block.content
    return content.trim().length > 0
  })
}

/**
 * Extract copyable text from the last agent turn in a flat block list.
 *
 * A turn starts after the last `user` block. Within the turn, sleep-sentinel
 * text blocks (`<sleep>` / `[sleep]`) are stripped — they are internal signals,
 * not response content. For a text block that ends with a sentinel the prefix
 * before the sentinel is kept (it may still contain real content).
 *
 * If the turn contains a `tool` block, only text blocks *after* the last one
 * count as the response — earlier text is narration the agent wrote before
 * or between tool calls, not the final answer.
 *
 * Returns empty string when there is no assistant text in the last turn.
 */
export function lastTurnText(blocks: ContentBlock[]): string {
  // Find the index of the last user block — everything after it is the last turn
  let startIdx = 0
  for (let i = blocks.length - 1; i >= 0; i--) {
    if (blocks[i].type === 'user') {
      startIdx = i + 1
      break
    }
  }

  // A block ending in a sentinel keeps any real content before it.
  return finalAnswerBlocks(blocks.slice(startIdx))
    .map((block) => extractSleepPrefix(block.content) ?? block.content)
    .join('\n\n')
}
