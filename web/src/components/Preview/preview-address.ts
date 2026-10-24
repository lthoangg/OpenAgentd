/**
 * What the Preview address bar was asked to show.
 *
 * Besides URLs and paths on the tab's own server, the bar takes workspace
 * files: a path relative to the workspace root (`docs/a.html`,
 * `./docs/a.html`), or a full path or `file://` link inside the workspace.
 */

export type AddressInput =
  /** A path on the tab's own server (`/pricing`). */
  | { kind: 'page'; path: string }
  /** A local server address (`localhost:3000`, `http://127.0.0.1:8080/x`). */
  | { kind: 'url'; url: string }
  /**
   * A workspace file, relative to the root. `fallback` (a full path typed
   * as-is) is the server path to use when it is not a workspace file.
   */
  | { kind: 'file'; path: string; fallback?: string }
  | { kind: 'invalid'; message: string }

function slashes(path: string): string {
  return path.replace(/\\/g, '/')
}

/** `path` relative to `workspace`, or null when it is not inside it. */
function insideWorkspace(path: string, workspace: string): string | null {
  const root = slashes(workspace).replace(/\/+$/, '')
  const full = slashes(path)
  if (!root || !full.startsWith(`${root}/`)) return null
  const rel = full.slice(root.length + 1)
  return rel || null
}

/** The local path of a `file://` URL (`file:///C:/x` → `C:/x`). */
function filePathOf(value: string): string | null {
  try {
    const pathname = decodeURIComponent(new URL(value).pathname)
    return /^\/[A-Za-z]:\//.test(pathname) ? pathname.slice(1) : pathname
  } catch {
    return null
  }
}

const URL_LIKE = /^(?:[a-z][a-z\d+.-]*:\/\/|[\w.-]*:\d+|localhost\b|\[)/i

export function parseAddress(raw: string, workspace: string): AddressInput | null {
  const value = raw.trim()
  if (!value) return null
  if (/^file:\/\//i.test(value)) {
    const local = filePathOf(value)
    const rel = local === null ? null : insideWorkspace(local, workspace)
    return rel ? { kind: 'file', path: rel } : { kind: 'invalid', message: `'${local ?? value}' is outside the workspace.` }
  }
  const rel = insideWorkspace(value, workspace)
  if (rel) return value.startsWith('/') ? { kind: 'file', path: rel, fallback: value } : { kind: 'file', path: rel }
  if (value.startsWith('/')) return { kind: 'page', path: value }
  if (URL_LIKE.test(value)) return { kind: 'url', url: value }
  return { kind: 'file', path: slashes(value).replace(/^(?:\.\/)+/, '') }
}
