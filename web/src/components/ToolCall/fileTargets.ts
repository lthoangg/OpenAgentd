/**
 * The files a tool row's menu opens ("Open <path>", right-click or a long
 * press): each file a ``patch`` left in place, or the file a ``read`` read,
 * at the line it started from. Other tools open none, so their rows keep the
 * system's menu. Read from the arguments the row already has (history's
 * short patch lists its files), so the menu never fetches anything.
 */
import type { FileRef } from '@/utils/file-refs'
import { patchFiles } from './diffUtils'

function readTarget(args: string | undefined): FileRef[] {
  let parsed: unknown
  try {
    parsed = args ? JSON.parse(args) : null
  } catch {
    return []
  }
  if (!parsed || typeof parsed !== 'object') return []
  const { path, offset } = parsed as { path?: unknown; offset?: unknown }
  if (typeof path !== 'string' || !path.trim()) return []
  // The tool reads a numeric string as its digits; 1 (or none) is the top.
  const line = typeof offset === 'number' ? offset : typeof offset === 'string' ? Number(offset.replace(/\D/g, '')) : NaN
  return [Number.isInteger(line) && line > 1 ? { path: path.trim(), line } : { path: path.trim() }]
}

/**
 * ``unapplied``: the patch failed (or has not finished), so only the files
 * it would update exist (an added one does not yet; a moved one is still at
 * its old path).
 */
export function toolFileTargets(name: string, args: string | undefined, unapplied: boolean): FileRef[] {
  if (name === 'read') return readTarget(args)
  if (name !== 'patch') return []
  const paths = patchFiles(args).flatMap((file) => {
    if (unapplied) return file.kind === 'update' ? [file.path] : []
    return file.kind === 'delete' ? [] : [file.moveTo ?? file.path]
  })
  return [...new Set(paths)].map((path) => ({ path }))
}
