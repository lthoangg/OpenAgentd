/**
 * The short arguments history sends for a patch or a plan still name the
 * files, count the lines and label the row.
 */
import { describe, expect, it } from 'bun:test'

import { getDiffStats, patchFileStats } from '@/components/ToolCall/diffUtils'
import { getToolDisplay } from '@/components/ToolCall/display'
import { extractToolPaths } from '@/stores/useAgentStore/helpers'
import { isPlanSubmission } from '@/utils/tool-names'

const SHORT_PATCH = JSON.stringify({
  files: [
    { path: 'src/a.ts', kind: 'update', additions: 2, deletions: 1, move_to: 'src/b.ts' },
    { path: 'new.md', kind: 'add', additions: 3, deletions: 0 },
  ],
}, null, 2)

describe('short tool arguments', () => {
  it('a short patch gives its files and counts', () => {
    expect(patchFileStats(SHORT_PATCH)).toEqual([
      { path: 'src/b.ts', kind: 'update', additions: 2, deletions: 1 },
      { path: 'new.md', kind: 'add', additions: 3, deletions: 0 },
    ])
    expect(getDiffStats('patch', SHORT_PATCH)).toEqual({ additions: 5, deletions: 1 })
    expect(getToolDisplay('patch', SHORT_PATCH).headerTitle).toBe('a.ts, b.ts, new.md')
    expect(extractToolPaths('patch', SHORT_PATCH)).toEqual(['src/a.ts', 'src/b.ts', 'new.md'])
  })

  it('a short plan edit says how many changes it made', () => {
    expect(getToolDisplay('plan', JSON.stringify({ action: 'edit', edit_count: 2 })).headerTitle).toBe('edit · 2 changes')
  })

  it('a short plan submission still counts as one', () => {
    expect(isPlanSubmission('plan', JSON.stringify({ action: 'write', submit: true }, null, 2))).toBe(true)
  })
})
