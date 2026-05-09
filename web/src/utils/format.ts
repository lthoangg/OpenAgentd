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

export function formatTime(date: Date): string {
  return date.toLocaleTimeString(undefined, {
    hour: 'numeric',
    minute: '2-digit',
    hour12: false,
  })
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

import { isToday, isYesterday, format } from 'date-fns'

// Me format date+time: "Today 14:32", "Yesterday 09:01", or "DD/MM/YYYY 14:32"
export function formatRelativeDate(dateStr: string | null): string {
  if (!dateStr) return ''
  const date = new Date(dateStr)
  const time = format(date, 'HH:mm')
  if (isToday(date)) return `Today ${time}`
  if (isYesterday(date)) return `Yesterday ${time}`
  return `${format(date, 'dd/MM/yyyy')} ${time}`
}

// ── IANA timezone helpers ────────────────────────────────────────────────────
//
// The browser's `Intl` API can both render a given UTC instant in any IANA
// zone and tell us the UTC offset of that zone at any instant. We avoid
// pulling in `date-fns-tz` for two small helpers.

/**
 * Me get the offset (in minutes, east-of-UTC) that the IANA `timeZone` was
 * at the given UTC instant. e.g. `Asia/Ho_Chi_Minh` → 420 always;
 * `America/New_York` → -300 (EST) or -240 (EDT) depending on the date.
 *
 * Returns 0 (UTC) for unknown zones rather than throwing.
 */
export function getTimezoneOffsetMinutes(timeZone: string, instant: Date): number {
  try {
    const dtf = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    })
    const parts = dtf.formatToParts(instant)
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
  let off = getTimezoneOffsetMinutes(timeZone, new Date(utcGuess))
  let instant = utcGuess - off * 60_000
  off = getTimezoneOffsetMinutes(timeZone, new Date(instant))
  instant = utcGuess - off * 60_000

  const sign = off >= 0 ? '+' : '-'
  const abs = Math.abs(off)
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
    const dtf = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit',
    })
    const parts = dtf.formatToParts(date)
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
    const dtf = new Intl.DateTimeFormat('en-GB', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit',
    })
    const parts = dtf.formatToParts(date)
    const map: Record<string, string> = {}
    for (const p of parts) if (p.type !== 'literal') map[p.type] = p.value
    return `${map.day}/${map.month}/${map.year} ${map.hour}:${map.minute}`
  } catch {
    return format(date, 'dd/MM/yyyy HH:mm')
  }
}

import type { ContentBlock } from '@/api/types'

/**
 * Extract copyable text from the last agent turn in a flat block list.
 *
 * A turn starts after the last `user` block. Within the turn, sleep-sentinel
 * text blocks (`<sleep>` / `[sleep]`) are stripped — they are internal signals,
 * not response content. For a text block that ends with a sentinel the prefix
 * before the sentinel is kept (it may still contain real content).
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

  const turnBlocks = blocks.slice(startIdx)
  const parts: string[] = []

  for (const block of turnBlocks) {
    if (block.type !== 'text') continue
    const sleepPrefix = extractSleepPrefix(block.content)
    if (sleepPrefix !== null) {
      // Block ends with a sentinel — keep any real content before it
      if (sleepPrefix.length > 0) parts.push(sleepPrefix)
      // Skip the sentinel itself — it's an internal signal
    } else {
      parts.push(block.content)
    }
  }

  return parts.join('\n\n')
}
