import { describe, expect, it } from 'bun:test'

import type { ContentBlock } from '@/api/types'
import { readerSegments, summarizeWork, turnChangedFiles, workSummaryDetail } from '@/components/ReaderTurn/segments'

const text = (id: string, content = 'prose'): ContentBlock => ({ id, type: 'text', content })
const thinking = (id: string): ContentBlock => ({ id, type: 'thinking', content: 'hmm' })
function tool(id: string, toolName: string, args: unknown = {}, extra: Partial<ContentBlock> = {}): ContentBlock {
  return { id, type: 'tool', content: '', toolName, toolArgs: JSON.stringify(args), toolDone: true, toolResult: 'ok', ...extra }
}
function patch(id: string, lines: string[], extra: Partial<ContentBlock> = {}): ContentBlock {
  return tool(id, 'patch', { patch_text: ['*** Begin Patch', ...lines, '*** End Patch'].join('\n') }, extra)
}
const report = (id: string): ContentBlock => ({ id, type: 'user', content: 'findings', extra: { from_agent: 'explorer#1' } })
const CLAIM = JSON.stringify({ status: 'complete', evidence: 'bun test: 0 failures' })
function goalClaim(id: string, toolResult: string | undefined, args = CLAIM): ContentBlock {
  return { id, type: 'tool', content: '', toolName: 'update_goal', toolArgs: args, toolDone: toolResult !== undefined, toolResult }
}
/** No ``ask_user`` card is waiting on the user. */
const settled = () => false

describe('readerSegments — what folds behind the work summary', () => {
  it('folds thinking, tool calls, and narration; the text after the last work is the answer', () => {
    const blocks = [thinking('t1'), tool('r1', 'read'), text('n1', 'Let me check the tests.'), tool('s1', 'shell'), text('a1'), text('a2')]

    expect(readerSegments(blocks, settled)).toEqual([
      { kind: 'work', indices: [0, 1, 2, 3] },
      { kind: 'block', index: 4 },
      { kind: 'block', index: 5 },
    ])
  })

  it('leaves a turn with no work as it is', () => {
    expect(readerSegments([text('a1'), text('a2')], settled)).toEqual([{ kind: 'block', index: 0 }, { kind: 'block', index: 1 }])
  })

  it('keeps what the user must see or act on out of the fold, in order', () => {
    const blocks = [
      { id: 'c1', type: 'compaction', content: 'summary' } as ContentBlock,
      tool('r1', 'read'),
      tool('q1', 'ask_user'),
      tool('m1', 'weather', {}, { extra: { mcp_app: { uri: 'ui://w' } } }),
      tool('s1', 'shell'),
      text('a1'),
      { id: 'e1', type: 'provider_status', content: 'boom', extra: { status: 'error' } } as ContentBlock,
    ]

    expect(readerSegments(blocks, (block) => block.id === 'q1')).toEqual([
      { kind: 'block', index: 0 },
      { kind: 'work', indices: [1, 4] },
      { kind: 'block', index: 2 },
      { kind: 'block', index: 3 },
      { kind: 'block', index: 5 },
      { kind: 'block', index: 6 },
    ])
  })

  it('folds a question once it no longer waits on the user', () => {
    const blocks = [tool('r1', 'read'), text('n1', 'One thing first.'), tool('q1', 'ask_user'), tool('s1', 'shell'), text('a1')]

    expect(readerSegments(blocks, settled)).toEqual([{ kind: 'work', indices: [0, 1, 2, 3] }, { kind: 'block', index: 4 }])
  })

  it('folds text a live turn has since followed with more work', () => {
    expect(readerSegments([text('n1'), tool('s1', 'shell', {}, { toolDone: false })], settled)).toEqual([{ kind: 'work', indices: [0, 1] }])
  })

  it("keeps a goal's outcome out of the fold: a claim being checked, achieved, blocked, or one that paused the goal", () => {
    const outcomes = [
      goalClaim('checking', undefined),
      goalClaim('achieved', 'The check confirmed the goal is met: 0 failures.\nThe goal is achieved.'),
      goalClaim('blocked', 'The goal is paused as blocked until the user resumes it.', JSON.stringify({ status: 'blocked', reason: 'No key.' })),
      goalClaim('paused', 'The check did not accept the claim: No output.\nIt rejected 3 claims in a row, so the goal is paused.'),
      goalClaim('check-paused', 'The completion check failed: The check could not run: timed out.\nThe check failed 3 times in a row, so the goal is paused until the user resumes it.'),
    ]
    for (const claim of outcomes) {
      expect(readerSegments([tool('r1', 'read'), claim, text('a1')], settled)).toEqual([
        { kind: 'work', indices: [0] },
        { kind: 'block', index: 1 },
        { kind: 'block', index: 2 },
      ])
    }
  })

  it('folds a rejected goal claim, or one the check failed on, with the work, since the agent keeps going', () => {
    const rejected = goalClaim('no', 'The check did not accept the claim: No output.\nThe goal stays active.')
    expect(readerSegments([tool('r1', 'read'), rejected, tool('s1', 'shell'), text('a1')], settled)).toEqual([
      { kind: 'work', indices: [0, 1, 2] },
      { kind: 'block', index: 3 },
    ])
    const unchecked = goalClaim('unchecked', 'The completion check failed: The check replied without a verdict.\nThe claim was neither accepted nor rejected, and the goal stays active.')
    expect(readerSegments([tool('r1', 'read'), unchecked, text('a1')], settled)).toEqual([
      { kind: 'work', indices: [0, 1] },
      { kind: 'block', index: 2 },
    ])
  })

  it("folds a subagent's report with the work, and the text before it as narration", () => {
    const blocks = [tool('d1', 'delegate'), text('n1', 'Waiting on the explorer.'), report('r1'), text('a1')]

    expect(readerSegments(blocks, settled)).toEqual([{ kind: 'work', indices: [0, 1, 2] }, { kind: 'block', index: 3 }])
  })

  it('starts a new fold after a compaction divider, so the work before and after it reads apart', () => {
    const blocks = [
      thinking('t1'), tool('r1', 'read'), text('n1', 'Running the tests next.'),
      { id: 'c1', type: 'compaction', content: 'summary' } as ContentBlock,
      tool('s1', 'shell'), text('a1'),
    ]

    expect(readerSegments(blocks, settled)).toEqual([
      { kind: 'work', indices: [0, 1, 2] },
      { kind: 'block', index: 3 },
      { kind: 'work', indices: [4] },
      { kind: 'block', index: 5 },
    ])
  })
})

describe('summarizeWork', () => {
  it('counts each kind of step, and failures', () => {
    const blocks = [
      thinking('t1'),
      tool('r1', 'read'), tool('r2', 'read'),
      tool('g1', 'grep'), tool('g2', 'glob'), tool('w1', 'web_search'),
      tool('f1', 'web_fetch'),
      tool('s1', 'shell', {}, { toolResult: '[Failed — exit code 1]\nnope' }),
      patch('p1', ['*** Update File: a.ts', '@@', '-a', '+b']),
      tool('d1', 'delegate'),
      report('rp1'),
      goalClaim('gc1', 'The check did not accept the claim: No output.\nThe goal stays active.'),
      text('n1'),
    ]

    const summary = summarizeWork(blocks)

    expect(summary).toEqual({ reads: 2, searches: 3, fetches: 1, commands: 1, edits: 1, reports: 1, checks: 1, other: 1, failed: 1, thought: true })
    expect(workSummaryDetail(summary)).toBe('2 reads, 3 searches, 1 fetch, 1 command, 1 edit, 1 report, 1 goal check, 1 other')
  })

  it('says nothing about steps for a trace that only thought', () => {
    expect(workSummaryDetail(summarizeWork([thinking('t1')]))).toBe('')
  })
})

describe('turnChangedFiles — what the turn edited', () => {
  it('sums each file across the turn, in the order first touched', () => {
    const blocks = [
      patch('p1', ['*** Update File: web/src/a.ts', '@@', '-x', '+y', '+z', '*** Add File: web/src/new.ts', '+one']),
      patch('p2', ['*** Update File: web/src/a.ts', '@@', '-y', '+w', '*** Update File: web/src/new.ts', '@@', '+two']),
      patch('p3', ['*** Delete File: old.md']),
    ]

    expect(turnChangedFiles(blocks)).toEqual([
      { path: 'web/src/a.ts', status: 'M', additions: 3, deletions: 2 },
      { path: 'web/src/new.ts', status: 'A', additions: 2, deletions: 0 },
      { path: 'old.md', status: 'D', additions: 0, deletions: 0 },
    ])
  })

  it('drops a file the turn created and deleted, and skips failed or running patches', () => {
    const blocks = [
      patch('p1', ['*** Add File: tmp.txt', '+x']),
      patch('p2', ['*** Delete File: tmp.txt']),
      patch('p3', ['*** Update File: a.ts', '@@', '+x'], { toolResult: 'Error: hunk did not apply' }),
      patch('p4', ['*** Update File: b.ts', '@@', '+x'], { toolDone: false }),
    ]

    expect(turnChangedFiles(blocks)).toEqual([])
  })
})
