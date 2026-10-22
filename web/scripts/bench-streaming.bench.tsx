/**
 * Benchmark: per-update work while an answer streams.
 *
 * Drives public behaviour only, so the same file runs on any revision:
 *
 *   cd web && bun test ./scripts/bench-streaming.bench.tsx
 *
 *   # compare with an older revision (see bench-prompt-jump.bench.tsx)
 *   (cd /tmp/before/web && BENCH_JSON=/tmp/stream-before.json bun test ./scripts/bench-streaming.bench.tsx)
 *   BENCH_BASELINE=/tmp/stream-before.json bun test ./scripts/bench-streaming.bench.tsx
 *
 * 1. Markdown: a ~60k-character answer that quotes a JSX snippet in a code
 *    fence streams in 250-character steps. Each step does what
 *    `MarkdownBlock` does: the chunker's settled chunks plus live tail, or a
 *    whole parse when the chunker says the text must render whole.
 * 2. Queue: a steer waits in the queue while 300 stream flushes replace
 *    `agentStreams` on a 2,000-block session; counts the queue's commits.
 * 3. Stream end: the same answer streams into a `MarkdownBlock`, then the
 *    stream ends; times that last commit, where code highlighting that
 *    waited for the end lands all at once.
 *
 * Times are Bun/happy-dom's: compare revisions, not frame budgets.
 */
import { afterAll, describe, expect, it } from 'bun:test'
import { Profiler } from 'react'
import { act, cleanup, render } from '@testing-library/react'

import { createMarkdownChunker } from '@/utils/markdown-chunks'
import { MarkdownBlock, parseMarkdownText } from '@/utils/markdown'
import { PendingMessageQueue } from '@/components/PendingMessageQueue'
import { useAgentStore } from '@/stores/useAgentStore'

const results: Record<string, number> = {}

function answer(target: number): string {
  const parts: string[] = []
  for (let i = 0; parts.join('\n').length < target; i++) {
    parts.push(`## Step ${i}`, '', `The \`round_${i}\` helper keeps **four** decimals until the total.`, '',
      '- read it', '- test it', '', '```ts', `export const total${i} = 1`, '```', '')
    if (i === 3) parts.push('```tsx', '<div className="card">', '  <Title />', '</div>', '```', '')
  }
  return parts.join('\n')
}

describe('streaming work per update', () => {
  it('markdown: parse work for an answer quoting JSX in a fence', () => {
    const text = answer(60_000)
    const runs: number[] = []
    for (let r = 0; r < 3; r++) {
      const chunk = createMarkdownChunker(parseMarkdownText)
      const t0 = performance.now()
      let steps = 0
      for (let end = 250; end <= text.length; end += 250, steps++) {
        const slice = text.slice(0, end)
        if (!chunk(slice)) parseMarkdownText(slice, true)
      }
      runs.push((performance.now() - t0) / steps)
    }
    results['markdown ms per update'] = runs.sort((a, b) => a - b)[1]
  }, 300_000)

  it('stream end: the commit when a long answer finishes', () => {
    // Real answers carry real code: 20-line fences, not one-liners.
    const parts: string[] = []
    for (let i = 0; parts.join('\n').length < 30_000; i++) {
      parts.push(`## Step ${i}`, '', `The \`round_${i}\` helper keeps **four** decimals.`, '', '```ts')
      for (let l = 0; l < 20; l++) parts.push(`export function step${i}_${l}(value: number): string { return (value * ${l}).toFixed(4) + "${i}" }`)
      parts.push('```', '')
    }
    const text = parts.join('\n')
    const runs: number[] = []
    for (let r = 0; r < 3; r++) {
      const view = render(<MarkdownBlock content="" sessionId="s1" isStreaming />)
      for (let end = 500; end <= text.length; end += 500) {
        act(() => view.rerender(<MarkdownBlock content={text.slice(0, end)} sessionId="s1" isStreaming />))
      }
      act(() => view.rerender(<MarkdownBlock content={text} sessionId="s1" isStreaming />))
      const t0 = performance.now()
      act(() => view.rerender(<MarkdownBlock content={text} sessionId="s1" isStreaming={false} />))
      runs.push(performance.now() - t0)
      cleanup()
    }
    results['stream end commit ms'] = runs.sort((a, b) => a - b)[1]
  }, 300_000)

  it('queue: commits while a steer waits and the stream flushes', () => {
    const blocks = Array.from({ length: 2000 }, (_, n) => ({ id: `old-${n}`, type: 'text', content: 'x' }))
    const stream = (i: number) => ({
      lead: {
        blocks,
        currentBlocks: [{ id: 'live', type: 'text', content: 'token '.repeat(i) }],
        status: 'working',
        usage: { promptTokens: 0, completionTokens: 0, cachedTokens: 0 },
      } as never,
    })
    useAgentStore.setState({
      sessionId: 's1',
      _pendingMessages: [{ id: 'pending-1', sessionId: 's1', content: 'Steer this way' }],
      agentStreams: stream(0),
    })
    const tally = { commits: 0, ms: 0 }
    render(
      <Profiler id="queue" onRender={(_id, _phase, duration) => { tally.commits += 1; tally.ms += duration }}>
        <PendingMessageQueue />
      </Profiler>,
    )
    tally.commits = 0
    tally.ms = 0
    const t0 = performance.now()
    for (let i = 1; i <= 300; i++) {
      act(() => {
        useAgentStore.setState({ agentStreams: stream(i) })
      })
    }
    results['queue commits per 300 flushes'] = tally.commits
    results['queue ms per 300 flushes'] = performance.now() - t0
    cleanup()
    expect(tally.commits).toBeGreaterThanOrEqual(0)
  })
})

afterAll(async () => {
  if (process.env.BENCH_JSON) await Bun.write(process.env.BENCH_JSON, JSON.stringify(results, null, 2))
  const baseline: Record<string, number> | null = process.env.BENCH_BASELINE
    ? JSON.parse(await Bun.file(process.env.BENCH_BASELINE).text())
    : null
  console.log(`\nstreaming benchmark${baseline ? ' — baseline → this revision' : ''}\n`)
  for (const [name, value] of Object.entries(results)) {
    const before = baseline?.[name]
    const cell = (v: number) => (Number.isInteger(v) ? String(v) : v.toFixed(2))
    console.log(`  ${name.padEnd(30)} ${before !== undefined ? `${cell(before).padStart(10)} → ` : ''}${cell(value)}`)
  }
  console.log()
})
