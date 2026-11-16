import { describe, expect, it } from 'bun:test'

import { patchFileStats } from '@/components/ToolCall/diffUtils'

describe('patchFileStats', () => {
  it('reports each touched file with its own line counts', () => {
    const args = JSON.stringify({
      patch_text: '*** Begin Patch\n*** Add File: new.ts\n+a\n+b\n*** Update File: old.ts\n@@\n-x\n+y\n*** Delete File: gone.ts\n*** End Patch',
    })
    expect(patchFileStats(args)).toEqual([
      { path: 'new.ts', kind: 'add', additions: 2, deletions: 0 },
      { path: 'old.ts', kind: 'update', additions: 1, deletions: 1 },
      { path: 'gone.ts', kind: 'delete', additions: 0, deletions: 0 },
    ])
  })

  it('reports a moved file under its new path', () => {
    const args = JSON.stringify({ patch_text: '*** Begin Patch\n*** Update File: a.ts\n*** Move to: b.ts\n@@\n-x\n+y\n*** End Patch' })
    expect(patchFileStats(args)).toEqual([{ path: 'b.ts', kind: 'update', additions: 1, deletions: 1 }])
  })

  it('returns nothing for unparsable arguments', () => {
    expect(patchFileStats('{not json')).toEqual([])
    expect(patchFileStats(undefined)).toEqual([])
  })
})
