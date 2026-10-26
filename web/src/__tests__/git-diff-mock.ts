/**
 * Fake server answers for the Review dock's working-tree diff endpoints,
 * derived from one whole-diff fixture: ``/git-diff/files`` gets the
 * fixture's changed paths, ``/git-diff/view?paths=p`` the section for ``p``.
 */
import { collectChangedFiles, collectDiffSections } from '@/components/WorkspacePanel/diff-helpers'
import type { WorkspaceChangesResponse, WorkspaceGitDiffResponse } from '@/api/types'

export function changesFromDiff(whole: WorkspaceGitDiffResponse): WorkspaceChangesResponse {
  const files = collectChangedFiles(whole)
  return { workspace: whole.workspace, is_git_repo: whole.is_git_repo, files, total: files.length, truncated: false }
}

export function scopedDiff(whole: WorkspaceGitDiffResponse, paths: string[]): WorkspaceGitDiffResponse {
  const sections = collectDiffSections(whole)
  return {
    ...whole,
    diff: paths.flatMap((path) => sections.get(path)?.diff ?? []).join('\n'),
    untracked: (whole.untracked ?? []).filter((path) => paths.includes(path)),
  }
}

export function gitDiffResponse(url: string, whole: WorkspaceGitDiffResponse): Response {
  if (url.includes('/git-diff/files')) return new Response(JSON.stringify(changesFromDiff(whole)))
  const paths = new URL(url, 'http://localhost').searchParams.getAll('paths')
  return new Response(JSON.stringify(paths.length > 0 ? scopedDiff(whole, paths) : whole))
}
