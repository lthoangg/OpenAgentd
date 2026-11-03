/**
 * File links in terminal output: ``src/foo.ts:42``, ``./a/b.rs(10,3)``,
 * ``/abs/path/file.py:3``. Pure (no xterm import) so it is testable without
 * the renderer: ``createFileLinkProvider`` takes a structural view of the
 * buffer and returns an object shaped like xterm's ``ILinkProvider``.
 *
 * Recognition reuses ``findFileRefs`` (the chat's conservative matcher: a
 * folder or a line number is needed, so versions, times and plain
 * ``config.enabled`` stay text), adds the ``(line,col)`` form compilers print,
 * and leaves URLs to the web-links addon.
 *
 * Plain click keeps selecting; ⌘ (macOS) or Ctrl (elsewhere) + click opens.
 */
import { getPlatform, type OS } from '@/hooks/use-platform'
import { isPrimaryModifierOS } from '@/lib/keyboard-shortcut'
import { findFileRefs, workspaceRelativePath, type FileRef } from '@/utils/file-refs'

export interface FileLinkMatch {
  start: number
  end: number
  text: string
  ref: FileRef
}

const URL_RE = /[a-z][a-z0-9+.-]*:\/\/\S+/gi
const PAREN_POSITION = /^\((\d+)(?:\s*,\s*(\d+))?\)/

/** File references in one line of terminal text, in order. */
export function findTerminalFileLinks(text: string): FileLinkMatch[] {
  const urls = [...text.matchAll(URL_RE)].map((match) => [match.index, match.index + match[0].length] as const)
  const links: FileLinkMatch[] = []
  for (const found of findFileRefs(text)) {
    if (urls.some(([from, to]) => found.start < to && found.end > from)) continue
    let { end, ref } = found
    if (ref.line === undefined) {
      const paren = PAREN_POSITION.exec(text.slice(end))
      const line = paren ? Number(paren[1]) : 0
      if (paren && line >= 1) {
        ref = { ...ref, line, ...(paren[2] !== undefined ? { column: Number(paren[2]) } : {}) }
        end += paren[0].length
      }
    }
    links.push({ start: found.start, end, text: text.slice(found.start, end), ref })
  }
  return links
}

const asSlashes = (path: string) => path.replace(/\\/g, '/')

/**
 * The workspace-relative path a terminal path names, or ``null`` when it
 * leaves the workspace. Relative paths resolve against the shell's cwd (from
 * OSC 7) when known, else the workspace root.
 */
export function resolveTerminalPath(path: string, cwd: string | null, workspace: string | null): string | null {
  if (!workspace) return null
  const root = asSlashes(workspace).replace(/\/+$/, '')
  const target = asSlashes(path)
  if (target.startsWith('~')) return null
  const absolute = target.startsWith('/') || /^[A-Za-z]:\//.test(target)
  const base = cwd ? asSlashes(cwd).replace(/\/+$/, '') : null
  const joined = absolute ? target : base ? `${base}/${target}` : null
  // No cwd: the path is read from the workspace root.
  if (joined === null) return workspaceRelativePath(target, root)
  if (!joined.startsWith(`${root}/`)) return null
  return workspaceRelativePath(joined.slice(root.length + 1), root)
}

/** The directory in an OSC 7 payload (``file://host/path``), or ``null``. */
export function parseOsc7Cwd(data: string): string | null {
  const match = /^(?:file|kitty-shell-cwd):\/\/[^/]*(\/.*)$/.exec(data.trim())
  if (!match) return null
  let path: string
  try {
    path = decodeURIComponent(match[1])
  } catch {
    return null
  }
  // ``/C:/Users/me`` is a Windows drive path.
  return path.replace(/^\/([A-Za-z]:\/)/, '$1')
}

/** A click that opens the file: ⌘ on macOS, Ctrl elsewhere. A plain click selects. */
export function isFileLinkActivation(event: MouseEvent, os: OS): boolean {
  return isPrimaryModifierOS(os) ? event.metaKey : event.ctrlKey
}

export interface LinkCell {
  getChars: () => string
  getWidth: () => number
}
export interface LinkBufferLine {
  isWrapped: boolean
  getCell: (x: number) => LinkCell | undefined
}
/** The part of xterm's active buffer the provider reads. */
export interface LinkBuffer {
  cols: number
  length: number
  getLine: (y: number) => LinkBufferLine | undefined
}

interface Position {
  x: number
  y: number
  width: number
}

/** A logical line is a row plus the rows it soft-wraps into: cap it. */
const MAX_ROWS = 12

function readLogicalLine(buffer: LinkBuffer, y: number): { text: string; at: Position[] } | null {
  let first = y - 1
  while (first > 0 && buffer.getLine(first)?.isWrapped) first--
  let last = y - 1
  while (last + 1 < buffer.length && buffer.getLine(last + 1)?.isWrapped) last++
  if (last - first >= MAX_ROWS) return null
  let text = ''
  const at: Position[] = []
  for (let row = first; row <= last; row++) {
    const line = buffer.getLine(row)
    if (!line) return null
    for (let x = 0; x < buffer.cols; x++) {
      const cell = line.getCell(x)
      if (!cell) break
      const width = cell.getWidth()
      if (width === 0) continue
      const chars = cell.getChars() || ' '
      text += chars
      for (let unit = 0; unit < chars.length; unit++) at.push({ x: x + 1, y: row + 1, width })
    }
  }
  return { text, at }
}

export interface FileLinkProviderOptions {
  buffer: () => LinkBuffer
  /** Open the file; called only for a modified click. */
  open: (ref: FileRef) => void
  os?: OS
}

interface ProvidedLink {
  range: { start: { x: number; y: number }; end: { x: number; y: number } }
  text: string
  activate: (event: MouseEvent, text: string) => void
}

/** An xterm ``ILinkProvider`` for file paths; ``y`` is the 1-based buffer row. */
export function createFileLinkProvider(options: FileLinkProviderOptions) {
  return {
    provideLinks(y: number, callback: (links: ProvidedLink[] | undefined) => void): void {
      const line = readLogicalLine(options.buffer(), y)
      const links: ProvidedLink[] = []
      for (const match of line ? findTerminalFileLinks(line.text) : []) {
        const from = line!.at[match.start]
        const to = line!.at[match.end - 1]
        if (!from || !to || from.y > y || to.y < y) continue
        links.push({
          range: { start: { x: from.x, y: from.y }, end: { x: to.x + to.width - 1, y: to.y } },
          text: match.text,
          activate: (event) => {
            if (isFileLinkActivation(event, options.os ?? getPlatform().os)) options.open(match.ref)
          },
        })
      }
      callback(links.length > 0 ? links : undefined)
    },
  }
}
