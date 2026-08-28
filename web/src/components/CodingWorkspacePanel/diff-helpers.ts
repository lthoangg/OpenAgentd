import type { WorkspaceGitDiffResponse } from '@/api/types'

export type ChangedFileStatus = 'A' | 'M' | 'D'

export interface ChangedFileInfo {
  path: string
  status: ChangedFileStatus
  additions: number
  deletions: number
}

export interface DiffFileSection {
  path: string
  diff: string
}

export const CHANGED_STATUS_LABELS: Record<ChangedFileStatus, string> = {
  A: 'Added',
  M: 'Modified',
  D: 'Deleted',
}

export function safeDecodeURIComponent(val: string): string {
  try {
    return decodeURIComponent(val)
  } catch {
    return val
  }
}

export function collectChangedFiles(diff?: WorkspaceGitDiffResponse): ChangedFileInfo[] {
  const files = new Map<string, ChangedFileInfo>()
  if (!diff?.is_git_repo) return []

  let current: ChangedFileInfo | null = null
  // Same header/content split as DiffPreview: `new file mode` etc. only occur
  // in the per-file header (before the first `@@` hunk), and once content
  // starts every `+`/`-` line counts — including ones whose own content
  // begins with `--`/`++` (removed `---` frontmatter renders as `----`).
  let inFileHeader = true
  for (const line of diff.diff.split('\n')) {
    if (line.startsWith('diff --git ')) {
      inFileHeader = true
      const match = /^diff --git a\/(.*?) b\/(.*)$/.exec(line)
      if (!match?.[1] || !match[2]) {
        current = null
        continue
      }
      const path = match[2] === 'dev/null' ? match[1] : match[2]
      current = files.get(path) ?? { path, status: 'M', additions: 0, deletions: 0 }
      files.set(current.path, current)
      continue
    }
    if (!current) continue
    if (line.startsWith('@@')) {
      inFileHeader = false
      continue
    }
    if (inFileHeader) {
      if (line.startsWith('new file mode')) current.status = 'A'
      else if (line.startsWith('deleted file mode')) current.status = 'D'
      continue
    }
    if (line.startsWith('+')) current.additions += 1
    else if (line.startsWith('-')) current.deletions += 1
  }

  for (const path of diff.untracked ?? []) {
    const existing = files.get(path)
    if (existing) existing.status = 'A'
    else files.set(path, { path, status: 'A', additions: 0, deletions: 0 })
  }
  return Array.from(files.values()).sort((a, b) => a.path.localeCompare(b.path))
}

export function collectDiffSections(diff?: WorkspaceGitDiffResponse): Map<string, DiffFileSection> {
  const sections = new Map<string, DiffFileSection>()
  if (!diff?.is_git_repo) return sections

  let currentPath: string | null = null
  let currentLines: string[] = []
  const flush = () => {
    if (currentPath) sections.set(currentPath, { path: currentPath, diff: currentLines.join('\n') })
  }

  for (const line of diff.diff.split('\n')) {
    if (line.startsWith('diff --git ')) {
      flush()
      const match = /^diff --git a\/(.*?) b\/(.*)$/.exec(line)
      currentPath = match?.[2] === '/dev/null' ? match?.[1] ?? null : match?.[2] ?? null
      currentLines = [line]
      continue
    }
    if (currentPath) currentLines.push(line)
  }
  flush()
  return sections
}
