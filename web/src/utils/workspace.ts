export function normalizeWorkspaceInput(value: string): string | null {
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : null
}

export function pathBasename(path: string): string {
  const trimmed = path.replace(/[\\/]+$/, '')
  if (!trimmed) return path
  return trimmed.split(/[\\/]/).pop() || path
}

export function workspaceLabel(workspace: string): string {
  return pathBasename(workspace)
}

const CODING_WORKSPACES_KEY = 'oa-coding-workspaces'
const LAST_CODING_WORKSPACE_KEY = 'oa-last-coding-workspace'

export interface CodingWorkspaceEntry {
  id: string
  path: string
  createdAt: string
}

function workspaceId(workspace: string): string {
  let hash = 0
  for (let i = 0; i < workspace.length; i += 1) {
    hash = Math.imul(31, hash) + workspace.charCodeAt(i) | 0
  }
  return `w${(hash >>> 0).toString(36)}`
}

function parseEntries(raw: unknown): CodingWorkspaceEntry[] {
  if (!Array.isArray(raw)) return []
  return raw
    .map((item, index) => {
      const fallbackCreatedAt = new Date(index).toISOString()
      if (typeof item === 'string') return { id: workspaceId(item), path: item, createdAt: fallbackCreatedAt }
      if (item && typeof item === 'object' && 'path' in item && typeof item.path === 'string') {
        const id = 'id' in item && typeof item.id === 'string' ? item.id : workspaceId(item.path)
        const createdAt = 'createdAt' in item && typeof item.createdAt === 'string' ? item.createdAt : fallbackCreatedAt
        return { id, path: item.path, createdAt }
      }
      return null
    })
    .filter((item): item is CodingWorkspaceEntry => item !== null)
}

export function loadCodingWorkspaces(): string[] {
  return loadCodingWorkspaceEntries().map((entry) => entry.path)
}

export function loadCodingWorkspaceEntries(): CodingWorkspaceEntry[] {
  try {
    const raw = localStorage.getItem(CODING_WORKSPACES_KEY)
    return parseEntries(raw ? JSON.parse(raw) : [])
  } catch {
    return []
  }
}

export function saveCodingWorkspace(workspace: string): CodingWorkspaceEntry {
  const entries = loadCodingWorkspaceEntries()
  const existing = entries.find((item) => item.path === workspace)
  const entry = existing ?? { id: workspaceId(workspace), path: workspace, createdAt: new Date().toISOString() }
  const next = existing ? entries : [...entries, entry]
    .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt))
  try {
    localStorage.setItem(CODING_WORKSPACES_KEY, JSON.stringify(next))
    window.dispatchEvent(new CustomEvent('coding-workspaces-changed'))
  } catch {
    // ignore storage failures
  }
  return entry
}

/**
 * Removes a workspace from the saved list. Sessions belonging to it are
 * left untouched in the backend — reopening the same path later will
 * resurface them. Also clears the "last opened" pointer if it was this
 * workspace, so a stale id doesn't get auto-restored on next launch.
 */
export function removeCodingWorkspace(workspace: string): void {
  try {
    const entries = loadCodingWorkspaceEntries().filter((entry) => entry.path !== workspace)
    localStorage.setItem(CODING_WORKSPACES_KEY, JSON.stringify(entries))
    const lastId = localStorage.getItem(LAST_CODING_WORKSPACE_KEY)
    if (lastId && !entries.some((entry) => entry.id === lastId)) {
      localStorage.removeItem(LAST_CODING_WORKSPACE_KEY)
    }
    window.dispatchEvent(new CustomEvent('coding-workspaces-changed'))
  } catch {
    // ignore storage failures
  }
}

export function saveLastCodingWorkspace(workspace: string): CodingWorkspaceEntry {
  const entry = saveCodingWorkspace(workspace)
  try {
    localStorage.setItem(LAST_CODING_WORKSPACE_KEY, entry.id)
  } catch {
    // ignore storage failures
  }
  return entry
}

export function loadLastCodingWorkspace(): CodingWorkspaceEntry | null {
  try {
    const id = localStorage.getItem(LAST_CODING_WORKSPACE_KEY)
    if (!id) return null
    return loadCodingWorkspaceEntries().find((entry) => entry.id === id) ?? null
  } catch {
    return null
  }
}

export function shouldRestoreLastCodingWorkspace(
  sessionId: string | undefined,
  pathname: string,
): boolean {
  return !sessionId && pathname === '/coding'
}

export function workspaceFromSession(
  sessionId: string | undefined,
  sessionWorkspace: string | null | undefined,
): string | null {
  if (!sessionId) return null
  return sessionWorkspace ?? null
}

const _VIDEO_EXTENSIONS = ['.mp4', '.webm', '.mov', '.m4v'] as const

/** Return true if ``src`` references a file with a video extension. */
export function isVideoSrc(src: string | undefined): boolean {
  if (!src) return false
  // Strip query string / fragment before extension check so
  // ``/api/agent/abc/media/clip.mp4?cache=123`` still matches.
  const cleaned = src.split(/[?#]/, 1)[0].toLowerCase()
  return _VIDEO_EXTENSIONS.some((ext) => cleaned.endsWith(ext))
}
