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

/**
 * Max LCS matrix cells (`oldMid.length * newMid.length`) we are willing to
 * spend on an exact minimal diff, measured *after* the common prefix/suffix
 * has been trimmed. 1M cells is a 4MB `Int32Array` and ~10ms — paid once per
 * distinct `(args, result)` pair because every caller memoizes.
 *
 * Above the budget we emit a correct-but-not-minimal block diff (all old
 * lines removed, then all new lines added) rather than allocating a matrix
 * that grows quadratically: a 3000x3000 edit would otherwise cost ~69MB and
 * ~60ms on the main thread.
 */
export const MAX_LCS_CELLS = 1_000_000

/**
 * Exact minimal line diff via LCS backtracking.
 *
 * Uses a flat `Int32Array` (one allocation, half the footprint of the
 * `number[][]` it replaced) and builds the output with `push` + `reverse`.
 * The previous implementation `unshift`ed each line, which re-shifted the
 * whole array per line and made *output construction alone* quadratic in the
 * diff length, independently of the matrix cost.
 */
function diffLinesExact(oldLines: string[], newLines: string[]): DiffLine[] {
  const m = oldLines.length
  const n = newLines.length
  const width = n + 1
  const dp = new Int32Array((m + 1) * width)

  for (let i = 1; i <= m; i++) {
    const row = i * width
    const prevRow = row - width
    const oldLine = oldLines[i - 1]
    for (let j = 1; j <= n; j++) {
      dp[row + j] =
        oldLine === newLines[j - 1]
          ? dp[prevRow + j - 1] + 1
          : Math.max(dp[prevRow + j], dp[row + j - 1])
    }
  }

  const result: DiffLine[] = []
  let i = m
  let j = n
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && oldLines[i - 1] === newLines[j - 1]) {
      result.push({ type: 'equal', value: oldLines[i - 1] })
      i--
      j--
    } else if (j > 0 && (i === 0 || dp[i * width + (j - 1)] >= dp[(i - 1) * width + j])) {
      result.push({ type: 'added', value: newLines[j - 1] })
      j--
    } else {
      result.push({ type: 'removed', value: oldLines[i - 1] })
      i--
    }
  }
  result.reverse()
  return result
}

/** Over-budget fallback: a valid diff, just not a minimal one. Keeps the
 *  removed-before-added ordering `diffLinesExact` produces. */
function diffLinesBlock(oldLines: string[], newLines: string[]): DiffLine[] {
  const result: DiffLine[] = []
  for (const value of oldLines) result.push({ type: 'removed', value })
  for (const value of newLines) result.push({ type: 'added', value })
  return result
}

/**
 * Line-by-line diff.
 *
 * The common prefix and suffix are trimmed in O(m+n) before the quadratic
 * core runs. Real `edit` calls rewrite a few lines inside a larger block, so
 * this usually shrinks the matrix to near-nothing — and it bounds what the
 * cell budget above has to reject.
 */
export function diffLines(oldStr: string, newStr: string): DiffLine[] {
  const oldLines = oldStr.replace(/\r\n/g, '\n').split('\n')
  const newLines = newStr.replace(/\r\n/g, '\n').split('\n')

  const shorter = Math.min(oldLines.length, newLines.length)

  let prefix = 0
  while (prefix < shorter && oldLines[prefix] === newLines[prefix]) prefix++

  // Cap the suffix so prefix + suffix can never exceed the shorter input —
  // otherwise a fully-identical input would count the same line twice.
  const maxSuffix = shorter - prefix
  let suffix = 0
  while (
    suffix < maxSuffix &&
    oldLines[oldLines.length - 1 - suffix] === newLines[newLines.length - 1 - suffix]
  ) {
    suffix++
  }

  const oldMid = oldLines.slice(prefix, oldLines.length - suffix)
  const newMid = newLines.slice(prefix, newLines.length - suffix)

  const middle =
    oldMid.length * newMid.length > MAX_LCS_CELLS
      ? diffLinesBlock(oldMid, newMid)
      : diffLinesExact(oldMid, newMid)

  const result: DiffLine[] = []
  for (let i = 0; i < prefix; i++) result.push({ type: 'equal', value: oldLines[i] })
  for (const line of middle) result.push(line)
  for (let i = oldLines.length - suffix; i < oldLines.length; i++) {
    result.push({ type: 'equal', value: oldLines[i] })
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
        } else if (!line.startsWith('***') && !line.startsWith('@@')) {
          pushCurrentLine({ type: 'added', value: line })
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

export function getDiffStats(toolName: string, args: string, _result?: string): { additions: number; deletions: number } | null {
  try {
    const parsed = JSON.parse(args)
    if (!parsed) return null

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

  } catch {
    // ignore
  }
  return null
}
