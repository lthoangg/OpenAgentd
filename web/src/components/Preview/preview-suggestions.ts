/**
 * What the Preview address field offers when focused: the addresses
 * previewed last in this workspace, and the workspace's HTML pages.
 */

export interface AddressSuggestion {
  group: 'recent' | 'page'
  /** As listed: a recent address without `http://`, a page's workspace path. */
  label: string
  /** What the address bar is given when the row is chosen. */
  value: string
}

const MAX_PAGES = 8

/** An address without `http://`. `https://` stays: it is the one that differs. */
export function shortAddress(url: string): string {
  return url.replace(/^http:\/\//i, '')
}

const depth = (path: string) => path.split('/').length

export function addressSuggestions({ recent, files, query, current }: {
  recent: readonly string[]
  /** Workspace-relative file paths. */
  files: readonly string[]
  /** What was typed; empty lists everything. */
  query: string
  /** The address the tab shows, which is not offered again. */
  current: string
}): AddressSuggestion[] {
  const needle = shortAddress(query.trim()).toLowerCase()
  const shown = shortAddress(current)
  const matches = (label: string) => !needle || label.toLowerCase().includes(needle)
  const recents = recent
    .map((url) => ({ group: 'recent' as const, label: shortAddress(url), value: url }))
    .filter((item) => item.label !== shown && matches(item.label))
  const pages = files
    .filter((path) => /\.html?$/i.test(path) && `/${path}` !== shown && matches(path))
    .sort((a, b) => depth(a) - depth(b) || a.localeCompare(b))
    .slice(0, MAX_PAGES)
    .map((path) => ({ group: 'page' as const, label: path, value: path }))
  return [...recents, ...pages]
}
