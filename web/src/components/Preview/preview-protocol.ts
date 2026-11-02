/**
 * Messages between the Preview tab and the inspector script the preview
 * listener adds to each page (`appv3/crates/preview/assets/inspector.js`).
 *
 * The page runs on its own loopback origin, so every message is checked for
 * both the expected origin and the tab's own iframe window before use.
 */
import type { FrameKeymap } from '@/lib/keyboard/frames'

export const PREVIEW_NS = 'openagentd-preview'
export const PREVIEW_VERSION = 1

export interface ElementRect {
  x: number
  y: number
  width: number
  height: number
}

/** Best-effort component source from framework dev builds. */
export interface ElementSource {
  file: string | null
  line: number | null
  component: string | null
}

export interface ElementDescriptor {
  selector: string
  tag: string
  id: string | null
  classes: string[]
  role: string | null
  ariaLabel: string | null
  text: string
  /** The element's opening tag. */
  html: string
  /** Viewport rect inside the page, in CSS pixels. */
  rect: ElementRect
  styles: Record<string, string>
  source: ElementSource | null
  /** Page path (with query and hash) the element was picked on. */
  path: string
}

export interface PreviewConsoleEntry {
  level: 'error' | 'warn' | 'info' | 'log' | 'debug'
  message: string
  url: string
  ts: number
}

export type InspectMode = 'browse' | 'inspect'

export type PageMessage =
  /** ``doc`` names the document, the same on every ready it sends (absent from older inspectors). */
  | { type: 'ready'; path: string; title: string; status: 'ok' | 'down'; doc?: string }
  | { type: 'location'; path: string; title: string }
  /** The page started to navigate away (``beforeunload``). */
  | { type: 'leaving' }
  | { type: 'select'; element: ElementDescriptor }
  | { type: 'console'; entries: PreviewConsoleEntry[] }
  | { type: 'mode'; mode: InspectMode }
  /** The agent ran a command in the page (snapshot, click, …). */
  | { type: 'agent'; action: string }
  /** A dock shortcut pressed while focus was in the page. */
  | { type: 'shortcut'; name: 'toggle-design' | 'close-tab' }

export type DockCommand =
  | { type: 'hello' }
  | { type: 'set-mode'; mode: InspectMode }
  | { type: 'pins'; pins: { n: number; selector: string }[] }
  | { type: 'reload' }
  | { type: 'navigate'; path: string }
  | { type: 'history'; dir: -1 | 1 }
  /** App shortcuts the page should forward (``lib/keyboard/frames``). */
  | { type: 'keymap'; keymap: FrameKeymap }

const LEVELS = new Set(['error', 'warn', 'info', 'log', 'debug'])

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

const str = (value: unknown, fallback = ''): string => (typeof value === 'string' ? value : fallback)
const strOrNull = (value: unknown): string | null => (typeof value === 'string' ? value : null)
const num = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) ? value : 0)

function parseSource(value: unknown): ElementSource | null {
  if (!isRecord(value)) return null
  const line = typeof value.line === 'number' && Number.isFinite(value.line) ? value.line : null
  return { file: strOrNull(value.file), line, component: strOrNull(value.component) }
}

export function parseElement(value: unknown): ElementDescriptor | null {
  if (!isRecord(value) || typeof value.selector !== 'string' || typeof value.tag !== 'string') return null
  const rect = isRecord(value.rect) ? value.rect : {}
  const styles: Record<string, string> = {}
  if (isRecord(value.styles)) {
    for (const [k, v] of Object.entries(value.styles)) if (typeof v === 'string') styles[k] = v
  }
  return {
    selector: value.selector,
    tag: value.tag,
    id: strOrNull(value.id),
    classes: Array.isArray(value.classes) ? value.classes.filter((c): c is string => typeof c === 'string').slice(0, 8) : [],
    role: strOrNull(value.role),
    ariaLabel: strOrNull(value.ariaLabel),
    text: str(value.text),
    html: str(value.html),
    rect: { x: num(rect.x), y: num(rect.y), width: num(rect.width), height: num(rect.height) },
    styles,
    source: parseSource(value.source),
    path: str(value.path, '/'),
  }
}

function parseEntries(value: unknown): PreviewConsoleEntry[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((e) => {
    if (!isRecord(e) || typeof e.message !== 'string') return []
    const level = LEVELS.has(str(e.level)) ? (e.level as PreviewConsoleEntry['level']) : 'log'
    return [{ level, message: e.message, url: str(e.url), ts: num(e.ts) }]
  })
}

/** Parse a page message, or ``null`` when it is not from ``frame`` at ``origin``. */
export function parsePageMessage(event: Pick<MessageEvent, 'origin' | 'source' | 'data'>, origin: string, frame: Window | null | undefined): PageMessage | null {
  if (!frame || event.source !== frame || event.origin !== origin) return null
  const data: unknown = event.data
  if (!isRecord(data) || data.ns !== PREVIEW_NS || data.v !== PREVIEW_VERSION) return null
  switch (data.type) {
    case 'ready': {
      const ready: Extract<PageMessage, { type: 'ready' }> = { type: 'ready', path: str(data.path, '/'), title: str(data.title), status: data.status === 'down' ? 'down' : 'ok' }
      if (typeof data.doc === 'string' && data.doc) ready.doc = data.doc.slice(0, 64)
      return ready
    }
    case 'location':
      return { type: 'location', path: str(data.path, '/'), title: str(data.title) }
    case 'leaving':
      return { type: 'leaving' }
    case 'select': {
      const element = parseElement(data.element)
      return element ? { type: 'select', element } : null
    }
    case 'console':
      return { type: 'console', entries: parseEntries(data.entries) }
    case 'mode':
      return { type: 'mode', mode: data.mode === 'inspect' ? 'inspect' : 'browse' }
    case 'agent':
      return typeof data.action === 'string' && data.action ? { type: 'agent', action: data.action.slice(0, 40) } : null
    case 'shortcut':
      return data.name === 'toggle-design' || data.name === 'close-tab' ? { type: 'shortcut', name: data.name } : null
    default:
      return null
  }
}

export function commandMessage(command: DockCommand): Record<string, unknown> {
  return { ...command, ns: PREVIEW_NS, v: PREVIEW_VERSION }
}
