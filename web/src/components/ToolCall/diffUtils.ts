export interface DiffLine {
  type: 'added' | 'removed' | 'equal'
  value: string
  oldStart?: number
  newStart?: number
}

export interface DiffMeta {
  path?: string
  old_start?: number | null
  new_start?: number | null
  deleted_lines?: number | null
  files?: Array<{
    path: string
    hunks: Array<{
      old_start?: number | null
      new_start?: number | null
    }>
  }>
}

export interface FileDiff {
  path: string
  kind: 'add' | 'update' | 'delete'
  moveTo?: string
  lines: DiffLine[]
  hunkStarts?: Array<{
    oldStart: number
    newStart: number
  }>
}

// Simple LCS line-by-line diff algorithm
export function diffLines(oldStr: string, newStr: string): DiffLine[] {
  const oldLines = oldStr.replace(/\r\n/g, '\n').split('\n')
  const newLines = newStr.replace(/\r\n/g, '\n').split('\n')
  const m = oldLines.length
  const n = newLines.length

  const dp: number[][] = Array.from({ length: m + 1 }, () => Array(n + 1).fill(0))
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (oldLines[i - 1] === newLines[j - 1]) {
        dp[i][j] = dp[i - 1][j - 1] + 1
      } else {
        dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1])
      }
    }
  }

  const result: DiffLine[] = []
  let i = m
  let j = n
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && oldLines[i - 1] === newLines[j - 1]) {
      result.unshift({ type: 'equal', value: oldLines[i - 1] })
      i--
      j--
    } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
      result.unshift({ type: 'added', value: newLines[j - 1] })
      j--
    } else {
      result.unshift({ type: 'removed', value: oldLines[i - 1] })
      i--
    }
  }
  return result
}

export function parseDiffMeta(result?: string): DiffMeta | null {
  if (!result) return null
  const firstLine = result.split('\n', 1)[0] ?? ''
  const prefix = '@@ openagentd-diff-meta '
  if (!firstLine.startsWith(prefix)) return null
  try {
    return JSON.parse(firstLine.slice(prefix.length)) as DiffMeta
  } catch {
    return null
  }
}

export function parsePatchText(patchText: string, meta?: DiffMeta | null): FileDiff[] {
  const lines = patchText.replace(/\r\n/g, '\n').split('\n')
  if (lines.length > 0 && lines[lines.length - 1] === '') {
    lines.pop()
  }
  if (lines.length < 1 || lines[0] !== '*** Begin Patch') {
    return []
  }

  const diffs: FileDiff[] = []
  let current: FileDiff | null = null
  let currentHunkIndex = -1
  let needsHunkStart = false

  const pushCurrentLine = (line: DiffLine) => {
    if (!current) return
    if (needsHunkStart) {
      const hunkStart = current.hunkStarts?.[currentHunkIndex]
      if (hunkStart) {
        line.oldStart = hunkStart.oldStart
        line.newStart = hunkStart.newStart
      }
      needsHunkStart = false
    }
    current.lines.push(line)
  }

  const hasEnd = lines.length > 0 && lines[lines.length - 1] === '*** End Patch'
  const endLimit = hasEnd ? lines.length - 1 : lines.length

  for (let i = 1; i < endLimit; i++) {
    const line = lines[i]
    if (line.startsWith('*** Add File: ')) {
      current = {
        path: line.substring('*** Add File: '.length).trim(),
        kind: 'add',
        lines: [],
        hunkStarts: meta?.files?.find((file) => file.path === line.substring('*** Add File: '.length).trim())?.hunks.map((hunk) => ({
          oldStart: hunk.old_start ?? 1,
          newStart: hunk.new_start ?? 1,
        })),
      }
      currentHunkIndex = 0
      needsHunkStart = true
      diffs.push(current)
    } else if (line.startsWith('*** Update File: ')) {
      current = {
        path: line.substring('*** Update File: '.length).trim(),
        kind: 'update',
        lines: [],
        hunkStarts: meta?.files?.find((file) => file.path === line.substring('*** Update File: '.length).trim())?.hunks.map((hunk) => ({
          oldStart: hunk.old_start ?? 1,
          newStart: hunk.new_start ?? 1,
        })),
      }
      currentHunkIndex = -1
      needsHunkStart = false
      diffs.push(current)
    } else if (line.startsWith('*** Delete File: ')) {
      current = {
        path: line.substring('*** Delete File: '.length).trim(),
        kind: 'delete',
        lines: [],
      }
      currentHunkIndex = -1
      needsHunkStart = false
      diffs.push(current)
    } else if (current) {
      if (line.startsWith('*** Move to: ')) {
        current.moveTo = line.substring('*** Move to: '.length).trim()
      } else if (line.startsWith('@@')) {
        currentHunkIndex += 1
        needsHunkStart = true
      } else if (current.kind === 'add') {
        if (line.startsWith('+')) {
          pushCurrentLine({ type: 'added', value: line.substring(1) })
        }
      } else if (current.kind === 'update') {
        if (line.startsWith('+')) {
          pushCurrentLine({ type: 'added', value: line.substring(1) })
        } else if (line.startsWith('-')) {
          pushCurrentLine({ type: 'removed', value: line.substring(1) })
        } else if (line.startsWith(' ')) {
          pushCurrentLine({ type: 'equal', value: line.substring(1) })
        }
      }
    }
  }
  return diffs
}

export function getDiffStats(toolName: string, args: string, result?: string): { additions: number; deletions: number } | null {
  try {
    const parsed = JSON.parse(args)
    if (!parsed) return null

    if (toolName === 'edit') {
      const oldStr = typeof parsed.old_string === 'string' ? parsed.old_string : ''
      const newStr = typeof parsed.new_string === 'string' ? parsed.new_string : ''
      const lines = diffLines(oldStr, newStr)
      let additions = 0
      let deletions = 0
      for (const line of lines) {
        if (line.type === 'added') additions++
        if (line.type === 'removed') deletions++
      }
      return { additions, deletions }
    }

    if (toolName === 'write') {
      const content = typeof parsed.content === 'string' ? parsed.content : ''
      const lines = content.replace(/\r\n/g, '\n').split('\n')
      return { additions: lines.length, deletions: 0 }
    }

    if (toolName === 'patch') {
      const patchText = typeof parsed.patch_text === 'string' ? parsed.patch_text : ''
      const diffs = parsePatchText(patchText)
      let additions = 0
      let deletions = 0
      for (const diff of diffs) {
        for (const line of diff.lines) {
          if (line.type === 'added') additions++
          if (line.type === 'removed') deletions++
        }
      }
      return { additions, deletions }
    }

    if (toolName === 'rm') {
      const meta = parseDiffMeta(result)
      if (typeof meta?.deleted_lines === 'number') {
        return { additions: 0, deletions: meta.deleted_lines }
      }
    }
  } catch {
    // ignore
  }
  return null
}
