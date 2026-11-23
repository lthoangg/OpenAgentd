/**
 * What the Browser address bar was asked to show.
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
  /** A page on another machine (`example.com/docs`), as a full URL. */
  | { kind: 'site'; url: string }
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
/** Hosts the preview server forwards to (`appv3/crates/preview/src/target.rs`). */
const LOCAL_HOST = /^(?:localhost|127(?:\.\d{1,3}){3}|0\.0\.0\.0|\[::1?\])$/i
/** `name.tld` at the start of an address, read as a site unless the "tld" is a web file's extension. */
const BARE_HOST = /^((?:[a-z\d-]+\.)+([a-z]{2,24}))(?=[/?#:]|$)/i
const FILE_EXTENSIONS = new Set([
  'html', 'htm', 'xhtml', 'svg', 'md', 'markdown', 'mdx', 'txt', 'json', 'xml', 'pdf', 'csv', 'yaml', 'yml', 'toml',
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'avif', 'ico', 'css', 'js', 'mjs', 'cjs', 'ts', 'tsx', 'jsx', 'map', 'wasm',
])

/** A site: `https://` unless the address names its own scheme. */
function site(value: string): AddressInput {
  return { kind: 'site', url: /^[a-z][a-z\d+.-]*:\/\//i.test(value) ? value : `https://${value}` }
}

/** The host of a URL-like address, as written (`[::1]` keeps its brackets). */
function hostOf(value: string): string | null {
  try {
    return new URL(/^[a-z][a-z\d+.-]*:\/\//i.test(value) ? value : `http://${value}`).hostname
  } catch {
    return null
  }
}

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
  if (URL_LIKE.test(value)) {
    const host = hostOf(value)
    // A bare `:5173` is localhost; anything naming another machine is a site.
    return host && !LOCAL_HOST.test(host) ? site(value) : { kind: 'url', url: value }
  }
  const bare = BARE_HOST.exec(value)
  if (bare && !FILE_EXTENSIONS.has(bare[2].toLowerCase())) return site(value)
  return { kind: 'file', path: slashes(value).replace(/^(?:\.\/)+/, '') }
}

/** What the address bar says for a site on a client that cannot show one. */
export function siteUnavailableMessage(url: string): string {
  let host = url
  try {
    host = new URL(url).hostname
  } catch {
    // Shown as typed.
  }
  return `Public sites such as ${host} open in the OpenAgentd desktop app on a Mac. Here, the Browser tab shows servers on this computer (localhost, 127.0.0.1) and workspace files.`
}
