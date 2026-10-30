/**
 * Cron preview for the task forms: checks an expression the way the
 * backend does (``appv3/crates/agent/src/scheduler/cron.rs``: 5 fields, an
 * optional 6th seconds field, ``@daily``-style aliases, names, ranges,
 * steps, ``L`` and ``dow#n``), describes the common shapes in words, and
 * finds the next fire time in the task's own wall clock.
 */

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec']
const DAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat']
const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

const ALIASES: Record<string, string> = {
  '@yearly': '0 0 1 1 *',
  '@annually': '0 0 1 1 *',
  '@monthly': '0 0 1 * *',
  '@weekly': '0 0 * * 0',
  '@daily': '0 0 * * *',
  '@midnight': '0 0 * * *',
  '@hourly': '0 * * * *',
}

interface Field {
  allowed: boolean[]
  star: boolean
}

interface Parsed {
  minute: Field
  hour: Field
  dom: Field
  domLast: boolean
  month: Field
  dow: Field
  dowNth: Array<[number, number]>
  fields: string[]
}

function nameValue(tok: string, names: string[] | null, offset: number): number | null {
  if (names) {
    const i = names.indexOf(tok.toLowerCase())
    if (i >= 0) return i + offset
  }
  return /^\d+$/.test(tok) ? Number(tok) : null
}

function parseField(spec: string, min: number, max: number, names: [string[], number] | null = null): Field | null {
  const allowed = Array<boolean>(max + 1).fill(false)
  const star = spec === '*' || spec === '?'
  for (const part of spec.split(',')) {
    if (part === '') return null
    const slash = part.indexOf('/')
    const range = slash >= 0 ? part.slice(0, slash) : part
    let step = 1
    if (slash >= 0) {
      const s = part.slice(slash + 1)
      if (!/^\d+$/.test(s) || Number(s) === 0) return null
      step = Number(s)
    }
    const val = (t: string) => nameValue(t, names?.[0] ?? null, names?.[1] ?? 0)
    let lo: number | null
    let hi: number | null
    if (range === '*' || range === '?') {
      lo = min
      hi = max
    } else if (range.includes('-')) {
      const [a, b] = range.split('-', 2)
      lo = val(a)
      hi = val(b)
    } else {
      lo = val(range)
      hi = slash >= 0 ? max : lo
    }
    if (lo === null || hi === null || lo < min || hi > max || lo > hi) return null
    for (let v = lo; v <= hi; v += step) allowed[v] = true
  }
  return { allowed, star }
}

function parse(expr: string): Parsed | null {
  const e = expr.trim()
  const expanded = ALIASES[e.toLowerCase()] ?? e
  const parts = expanded.split(/\s+/).filter(Boolean)
  if (parts.length !== 5 && parts.length !== 6) return null
  const minute = parseField(parts[0], 0, 59)
  const hour = parseField(parts[1], 0, 23)
  const domItems = parts[2].split(',')
  const domLast = domItems.some((x) => x.toLowerCase() === 'l')
  const domRest = domItems.filter((x) => x.toLowerCase() !== 'l')
  const dom = domRest.length ? parseField(domRest.join(','), 1, 31) : { allowed: Array<boolean>(32).fill(false), star: false }
  const month = parseField(parts[3], 1, 12, [MONTHS, 1])
  const dowNth: Array<[number, number]> = []
  const plain: string[] = []
  for (const item of parts[4].split(',')) {
    const hash = item.indexOf('#')
    if (hash >= 0) {
      const d = nameValue(item.slice(0, hash), DAYS, 0)
      const n = Number(item.slice(hash + 1))
      if (d === null || !Number.isInteger(n) || n < 1 || n > 5) return null
      dowNth.push([d % 7, n])
    } else {
      plain.push(item)
    }
  }
  const dow = plain.length ? parseField(plain.join(','), 0, 7, [DAYS, 0]) : { allowed: Array<boolean>(8).fill(false), star: false }
  if (parts.length === 6 && !parseField(parts[5], 0, 59)) return null
  if (!minute || !hour || !dom || !month || !dow) return null
  if (dow.allowed[7]) dow.allowed[0] = true
  return { minute, hour, dom, domLast, month, dow, dowNth, fields: parts }
}

export function isValidCron(expr: string): boolean {
  return parse(expr) !== null
}

const pad = (n: number) => String(n).padStart(2, '0')

/** The common shapes in words; ``null`` for anything else. */
function describe(p: Parsed): string | null {
  const [m, h, dom, mon, dow] = p.fields
  if (p.fields.length !== 5) return null
  const num = (s: string) => /^\d+$/.test(s)
  const every = (s: string) => /^\*\/(\d+)$/.exec(s)?.[1]
  if (m === '*' && h === '*' && dom === '*' && mon === '*' && dow === '*') return 'Every minute'
  if (every(m) && h === '*' && dom === '*' && mon === '*' && dow === '*') return `Every ${every(m)} minutes`
  if (num(m) && h === '*' && dom === '*' && mon === '*' && dow === '*') return `Every hour at :${pad(Number(m))}`
  if (num(m) && every(h) && dom === '*' && mon === '*' && dow === '*') return `Every ${every(h)} hours at :${pad(Number(m))}`
  if (!num(m) || !num(h)) return null
  const at = `at ${pad(Number(h))}:${pad(Number(m))}`
  if (dom === '*' && mon === '*') {
    if (dow === '*') return `Every day ${at}`
    const days = p.dow.allowed.slice(0, 7)
    if (p.dowNth.length) return null
    const picked = days.map((on, i) => (on ? i : -1)).filter((i) => i >= 0)
    if (picked.join() === '1,2,3,4,5') return `Weekdays ${at}`
    if (picked.join() === '0,6') return `Weekends ${at}`
    return `${picked.map((i) => DAY_NAMES[i]).join(', ')} ${at}`
  }
  if (mon === '*' && dow === '*') {
    if (p.domLast && dom.toLowerCase() === 'l') return `Last day of every month ${at}`
    if (num(dom)) return `Day ${Number(dom)} of every month ${at}`
  }
  return null
}

function dayMatches(p: Parsed, d: Date): boolean {
  const y = d.getUTCFullYear()
  const mo = d.getUTCMonth()
  const day = d.getUTCDate()
  const lastDay = new Date(Date.UTC(y, mo + 1, 0)).getUTCDate()
  const domOk = p.dom.allowed[day] || (p.domLast && day === lastDay)
  const wd = d.getUTCDay()
  const nth = Math.floor((day - 1) / 7) + 1
  const dowOk = p.dow.allowed[wd] || p.dowNth.some(([w, n]) => w === wd && n === nth)
  const domStar = p.dom.star && !p.domLast
  const dowStar = p.dow.star && p.dowNth.length === 0
  if (domStar && dowStar) return true
  if (domStar) return dowOk
  if (dowStar) return domOk
  return domOk || dowOk
}

/**
 * Next matching minute strictly after ``after``. Dates are naive wall-clock
 * times carried in a UTC ``Date`` (read with the ``getUTC*`` methods).
 */
function nextAfter(p: Parsed, after: Date): Date | null {
  let t = new Date(Date.UTC(after.getUTCFullYear(), after.getUTCMonth(), after.getUTCDate(), after.getUTCHours(), after.getUTCMinutes() + 1))
  const limit = after.getTime() + 366 * 5 * 86_400_000
  while (t.getTime() <= limit) {
    if (!p.month.allowed[t.getUTCMonth() + 1]) {
      t = new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth() + 1, 1))
      continue
    }
    if (!dayMatches(p, t)) {
      t = new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), t.getUTCDate() + 1))
      continue
    }
    if (!p.hour.allowed[t.getUTCHours()]) {
      t = new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), t.getUTCDate(), t.getUTCHours() + 1))
      continue
    }
    if (!p.minute.allowed[t.getUTCMinutes()]) {
      t = new Date(t.getTime() + 60_000)
      continue
    }
    return t
  }
  return null
}

export interface CronPreview {
  valid: boolean
  /** "Weekdays at 09:00", or null for shapes without a short description. */
  description: string | null
  /** "Mon Oct 27, 09:00" in the task's wall clock; null when there is none. */
  next: string | null
}

/**
 * ``nowWallClock`` is the current time in the task's timezone as
 * ``yyyy-MM-ddTHH:mm`` (``isoToWallClock(new Date().toISOString(), tz)``).
 */
export function previewCron(expr: string, nowWallClock: string): CronPreview {
  const p = parse(expr)
  if (!p) return { valid: false, description: null, next: null }
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(nowWallClock)
  const now = match ? new Date(Date.UTC(+match[1], +match[2] - 1, +match[3], +match[4], +match[5])) : null
  const n = now ? nextAfter(p, now) : null
  const next = n
    ? `${DAY_NAMES[n.getUTCDay()]} ${n.toLocaleString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' })}, ${pad(n.getUTCHours())}:${pad(n.getUTCMinutes())}`
    : null
  return { valid: true, description: describe(p), next }
}
