/**
 * File references in model text: ``src/app.ts:42``, ``src/app.ts:42:7``,
 * the ranges ``src/app.ts:42-58`` and ``src/app.ts#L42-L58``, and
 * ``src/app.ts#L42``, in code spans, link targets, and tool output.
 *
 * Recognition is deliberately conservative, because a false positive turns
 * code into a link that goes nowhere: free text needs a folder or a line
 * number, and a bare name in a code span needs a known extension, so
 * ``config.enabled`` and ``e.g.`` stay text.
 */

export interface FileRef {
  path: string
  line?: number
  column?: number
  /** Last line of a range; only ever after ``line``. */
  endLine?: number
}

/** Extensions that make a bare name (no folder) a file. */
const KNOWN_EXTENSIONS = new Set([
  'astro', 'bash', 'c', 'cc', 'cfg', 'cjs', 'clj', 'cmake', 'conf', 'cpp', 'cs', 'css', 'csv', 'cts', 'dart',
  'dockerfile', 'env', 'erl', 'ex', 'exs', 'fish', 'gql', 'go', 'gradle', 'graphql', 'h', 'hcl', 'hpp',
  'hs', 'htm', 'html', 'ini', 'java', 'jl', 'js', 'json', 'json5', 'jsonc', 'jsonl', 'jsx', 'kt', 'kts',
  'less', 'lock', 'log', 'lua', 'md', 'mdx', 'mjs', 'mk', 'ml', 'mts', 'ndjson', 'nim', 'nix',
  'php', 'plist', 'prisma', 'proto', 'ps1', 'py', 'pyi',
  'rb', 'rs', 'sass', 'scala', 'scss', 'sh', 'sql', 'svelte', 'svg', 'swift', 'tf', 'toml', 'ts', 'tsv',
  'tsx', 'txt', 'vue', 'xml', 'yaml', 'yml', 'zig', 'zsh',
])

/** Free text is capped so a huge log cannot mint thousands of links. */
const MAX_FREE_REFS = 500

// A segment never ends on a dot, so "see src/a.ts." leaves the full stop out.
const SEGMENT = String.raw`[\w@+-](?:[\w.@+-]*[\w@+-])?`
// A folder may be a dot folder such as `.agents/` or `.github/`.
const PATH = String.raw`(?:\.{1,2}\/|~\/|\/)?(?:\.?${SEGMENT}\/)*${SEGMENT}`
// :line[:column][-end], or a GitHub anchor #Lline[Ccolumn][-Lend[Ccolumn]].
// An en dash counts too: models write ranges as prose.
const POSITION = String.raw`(?::(\d+)(?::(\d+))?(?:[-–](\d+))?|#L(\d+)(?:C(\d+))?(?:-L?(\d+)(?:C\d+)?)?)`
const EXACT = new RegExp(`^(${PATH})${POSITION}?$`)
// The boundary before a path is checked in ``findFileRefs``: a lookbehind is a
// parse error before Safari 16.4.
const FREE = new RegExp(String.raw`(${PATH})${POSITION}?(?![\w/])`, 'g')
const PATH_CHAR = /[\w./@~:-]/
const HREF = new RegExp(`^(.+?)${POSITION}?$`)

function extensionOf(path: string): string | null {
  const name = path.slice(path.lastIndexOf('/') + 1)
  return /\.([A-Za-z][A-Za-z0-9]{0,9})$/.exec(name)?.[1].toLowerCase() ?? null
}

function withPosition(path: string, match: RegExpExecArray | RegExpMatchArray, offset: number): FileRef | null {
  // The two POSITION forms capture line, column, and end in that order.
  const at = match[offset] !== undefined ? offset : offset + 3
  const [line, column, end] = [match[at], match[at + 1], match[at + 2]]
  if (line === undefined) return { path }
  const start = Number(line)
  if (start < 1) return null
  const ref: FileRef = { path, line: start }
  if (column !== undefined) ref.column = Number(column)
  if (end !== undefined && Number(end) > start) ref.endLine = Number(end)
  return ref
}

/** A code span that is nothing but a file reference. */
export function parseFileRef(text: string): FileRef | null {
  const match = EXACT.exec(text.trim())
  if (!match) return null
  const path = match[1]
  const extension = extensionOf(path)
  if (!extension || (!path.includes('/') && !KNOWN_EXTENSIONS.has(extension))) return null
  return withPosition(path, match, 2)
}

/** A Markdown link target that names a workspace file rather than a page. */
export function parseFileHref(href: string): FileRef | null {
  const raw = href.trim()
  if (!raw || raw.startsWith('#') || raw.startsWith('//') || raw.includes('?')) return null
  if (/^[a-z][a-z0-9+.-]*:/i.test(raw)) return null
  let decoded: string
  try {
    decoded = decodeURI(raw)
  } catch {
    return null
  }
  const match = HREF.exec(decoded)
  if (!match || match[1].endsWith('/') || /[#:]/.test(match[1])) return null
  return withPosition(match[1], match, 2)
}

/** File references in free text, e.g. compiler or grep output, in order. */
export function findFileRefs(text: string): Array<{ start: number; end: number; ref: FileRef }> {
  const found: Array<{ start: number; end: number; ref: FileRef }> = []
  FREE.lastIndex = 0
  let match: RegExpExecArray | null
  while ((match = FREE.exec(text)) !== null) {
    // The old negative lookbehind: a path never starts right after a path
    // character, even one the previous match consumed. Retry one later.
    if (match.index > 0 && PATH_CHAR.test(text[match.index - 1])) {
      FREE.lastIndex = match.index + 1
      continue
    }
    const path = match[1]
    const hasLine = match[2] !== undefined || match[5] !== undefined
    if (!extensionOf(path) || (!path.includes('/') && !hasLine)) continue
    const ref = withPosition(path, match, 2)
    if (!ref) continue
    const start = match.index
    found.push({ start, end: start + match[0].length, ref })
    if (found.length >= MAX_FREE_REFS) break
  }
  return found
}

const MENTION_RANGE = /^#L(\d+)(?:-L?(\d+))?$/

/**
 * A composer ``@`` mention or a design feedback source, without the ``@``:
 * ``src/App.tsx#L42-L71``. The ``#L`` form is the wire format the backend
 * reads to attach those lines; a click reveals the same range.
 */
export function parseMentionRef(token: string): FileRef {
  const hash = token.indexOf('#')
  const path = hash < 0 ? token : token.slice(0, hash)
  const range = hash < 0 ? null : MENTION_RANGE.exec(token.slice(hash))
  const start = range ? Number(range[1]) : 0
  if (start < 1) return { path }
  const end = range?.[2] !== undefined ? Number(range[2]) : start
  return end > start ? { path, line: start, endLine: end } : { path, line: start }
}

/** ``path`` relative to ``workspace``, or ``null`` when it points outside it. */
export function workspaceRelativePath(path: string, workspace: string | null): string | null {
  if (path.startsWith('~')) return null
  let relative = path
  if (relative.startsWith('/')) {
    const root = workspace?.replace(/\/+$/, '')
    if (!root || !relative.startsWith(`${root}/`)) return null
    relative = relative.slice(root.length + 1)
  }
  const parts: string[] = []
  for (const part of relative.split('/')) {
    if (part === '' || part === '.') continue
    if (part === '..') {
      if (parts.length === 0) return null
      parts.pop()
      continue
    }
    parts.push(part)
  }
  return parts.length > 0 ? parts.join('/') : null
}

/**
 * The workspace paths a reference in the Markdown file ``fromFile`` may mean,
 * most likely first: from the file's folder (how links read on GitHub, and
 * how the file's images resolve), then from the workspace root (code spans
 * name files that way). A leading ``/`` is the workspace root unless it is the
 * workspace's own absolute path. Empty when the path leaves the workspace.
 */
export function documentRefCandidates(fromFile: string, path: string, workspace: string): string[] {
  if (path.startsWith('~')) return []
  const root = workspace.replace(/\/+$/, '')
  if (path.startsWith('/')) {
    const rel = path.startsWith(`${root}/`) ? workspaceRelativePath(path, workspace) : workspaceRelativePath(path.slice(1), workspace)
    return rel ? [rel] : []
  }
  const folder = fromFile.includes('/') ? fromFile.slice(0, fromFile.lastIndexOf('/')) : ''
  const candidates = [workspaceRelativePath(folder ? `${folder}/${path}` : path, workspace), workspaceRelativePath(path, workspace)]
  return [...new Set(candidates.filter((candidate): candidate is string => candidate !== null))]
}

/**
 * The listed file a reference in the Markdown file ``fromFile`` opens, or
 * ``null`` when it points outside the workspace. When the listing was cut
 * short, an unlisted file may still exist, so the likeliest path opens.
 */
export function resolveDocumentRef(
  fromFile: string,
  path: string,
  workspace: string,
  isListed: (path: string) => boolean,
  truncated = false,
): { kind: 'file'; path: string } | { kind: 'missing' } | null {
  const candidates = documentRefCandidates(fromFile, path, workspace)
  if (candidates.length === 0) return null
  const listed = candidates.find(isListed)
  if (listed) return { kind: 'file', path: listed }
  return truncated ? { kind: 'file', path: candidates[0] } : { kind: 'missing' }
}

export type WorkspaceRefMatch =
  | { kind: 'file'; path: string }
  | { kind: 'ambiguous'; paths: string[] }
  | { kind: 'missing' }

/**
 * The listed file a workspace-relative ``path`` means. Models cite files by
 * name alone or from a folder other than the root (``src/x.ts`` for
 * ``web/src/x.ts``), so the reference is a hint matched against the listing's
 * trailing segments. The newest match in ``touched`` (files this session
 * read or patched) wins, because what the agent worked on is what it is
 * talking about; then the exact path; then a match that is the only one.
 */
export function resolveWorkspaceRef(path: string, files: readonly string[], touched: readonly string[] = []): WorkspaceRefMatch {
  const suffix = `/${path}`
  const matches = files.filter((file) => file === path || file.endsWith(suffix))
  if (matches.length === 0) return { kind: 'missing' }
  const recent = touched.find((file) => matches.includes(file))
  if (recent) return { kind: 'file', path: recent }
  if (matches.includes(path)) return { kind: 'file', path }
  if (matches.length === 1) return { kind: 'file', path: matches[0] }
  return { kind: 'ambiguous', paths: matches }
}
