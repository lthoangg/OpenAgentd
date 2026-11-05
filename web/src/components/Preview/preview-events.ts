/**
 * Asking the chat shell to open a preview tab from anywhere (the `preview`
 * tool card), and reading the tool call's target.
 */
import type { PreviewTarget } from '@/api/preview'

export const PREVIEW_TOOL = 'preview'
export const OPEN_PREVIEW_EVENT = 'oa:open-preview'

export function requestOpenPreview(target: PreviewTarget): void {
  window.dispatchEvent(new CustomEvent<PreviewTarget>(OPEN_PREVIEW_EVENT, { detail: target }))
}

export function isPreviewTarget(value: unknown): value is PreviewTarget {
  if (typeof value !== 'object' || value === null) return false
  const v = value as Record<string, unknown>
  return (v.kind === 'url' && typeof v.url === 'string') || (v.kind === 'file' && typeof v.path === 'string')
}

/** The page a `preview` call with ``action: "open"`` shows, if any. */
export function previewTargetFromArgs(args: string | undefined): PreviewTarget | null {
  if (!args) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(args)
  } catch {
    return null
  }
  if (typeof parsed !== 'object' || parsed === null) return null
  const a = parsed as Record<string, unknown>
  if (a.action !== 'open') return null
  if (typeof a.url === 'string' && a.url.trim()) return { kind: 'url', url: a.url.trim() }
  if (typeof a.path === 'string' && a.path.trim()) return { kind: 'file', path: a.path.trim().replace(/^\.\//, '') }
  return null
}

/**
 * The backend's success text for an open call starts with this. Only such
 * answers reach the client with the call (``appv3_db::api::result_rides_inline``).
 */
export function isPreviewOpenSuccess(result: string | undefined): boolean {
  return typeof result === 'string' && result.startsWith('Opening ')
}
