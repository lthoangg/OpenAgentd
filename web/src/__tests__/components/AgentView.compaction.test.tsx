/**
 * Tests for compaction block rendering in ``AgentView``.
 *
 * Covers the regression where ``isStreaming`` was not forwarded to
 * ``CompactionDivider`` from the ``BlockRenderer`` compaction case, causing
 * summarization streaming content to not display properly.
 *
 * Strategy: mock ``CompactionDivider`` to capture forwarded props, then
 * render ``AgentView`` with compaction blocks in various positions and
 * working states to assert correct ``isStreaming`` values.
 */

import { describe, it, expect, afterEach, mock } from 'bun:test'
import { render, screen, cleanup } from '@testing-library/react'
import { AgentView } from '@/components/AgentView'
import { useAgentStore } from '@/stores/useAgentStore'
import type { ContentBlock } from '@/api/types'

afterEach(() => {
  cleanup()
  useAgentStore.setState({ sessionId: null, _pendingMessages: [] })
})

// Suppress lucide SVG noise in Happy DOM
mock.module('lucide-react', () => new Proxy({}, { get: () => () => null }))

// ---------------------------------------------------------------------------
// Capture CompactionDivider props on each render call
// ---------------------------------------------------------------------------

interface CapturedDividerCall {
  state: string
  isStreaming: boolean | undefined
  summary: string | undefined
  error: boolean | undefined
}

let dividerCalls: CapturedDividerCall[] = []

mock.module('@/components/CompactionDivider', () => ({
  CompactionDivider: (props: CapturedDividerCall) => {
    dividerCalls.push({ ...props })
    return (
      <div
        data-testid="compaction-divider"
        data-state={props.state}
        data-streaming={String(props.isStreaming ?? false)}
      >
        {props.summary ?? ''}
      </div>
    )
  },
}))

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeCompactionBlock(
  id: string,
  content: string,
  state: 'compacting' | 'compacted' = 'compacted',
): ContentBlock {
  return { id, type: 'compaction', content, extra: { state } }
}

function makeTextBlock(id: string, content: string): ContentBlock {
  return { id, type: 'text', content }
}

function makeUserBlock(id: string, content: string): ContentBlock {
  return { id, type: 'user', content }
}

function renderView(props: Partial<React.ComponentProps<typeof AgentView>> = {}) {
  dividerCalls = []
  return render(
    <AgentView
      blocks={props.blocks ?? []}
      currentBlocks={props.currentBlocks ?? []}
      isWorking={props.isWorking ?? false}
      onMentionFileOpen={props.onMentionFileOpen}
    />,
  )
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('AgentView — compaction block rendering', () => {
  it('renders CompactionDivider for a compacted block in finalized blocks', () => {
    renderView({
      blocks: [makeCompactionBlock('c1', 'Summary here', 'compacted')],
      currentBlocks: [],
      isWorking: false,
    })
    expect(screen.getAllByTestId('compaction-divider')).toHaveLength(1)
    expect(dividerCalls[0].state).toBe('compacted')
  })

  it('renders CompactionDivider for a compacting block in currentBlocks while working', () => {
    renderView({
      blocks: [],
      currentBlocks: [makeCompactionBlock('c1', 'Streaming summary…', 'compacting')],
      isWorking: true,
    })
    expect(screen.getAllByTestId('compaction-divider')).toHaveLength(1)
    expect(dividerCalls[0].state).toBe('compacting')
  })

  // ── Regression: isStreaming forwarding ───────────────────────────────────

  it('passes isStreaming=true to CompactionDivider for a compacting block in currentBlocks while working', () => {
    renderView({
      blocks: [],
      currentBlocks: [makeCompactionBlock('c1', 'Partial…', 'compacting')],
      isWorking: true,
    })
    // isStreaming must be true: block lives in currentBlocks (not yet finalized)
    // and isWorking is true — this is the live streaming phase.
    expect(dividerCalls[0].isStreaming).toBe(true)
  })

  it('passes isStreaming=true to CompactionDivider for a compacting block in finalized blocks while working', () => {
    // Compaction blocks live in `stream.blocks` in the real store during summarization_start/content.
    renderView({
      blocks: [makeCompactionBlock('c1', 'Partial summary in blocks…', 'compacting')],
      currentBlocks: [],
      isWorking: true,
    })
    expect(dividerCalls[0].isStreaming).toBe(true)
  })

  it('passes isStreaming=false to CompactionDivider for a finalized compacted block', () => {
    renderView({
      blocks: [makeCompactionBlock('c1', 'Final summary', 'compacted')],
      currentBlocks: [],
      isWorking: false,
    })
    expect(dividerCalls[0].isStreaming).toBe(false)
  })

  it('passes isStreaming=false to a finalized compacted block even when agent is still working on subsequent content', () => {
    // A previous compaction in `blocks` (finalized) must not be treated as
    // streaming just because the agent is currently working on new content.
    renderView({
      blocks: [
        makeUserBlock('u1', 'Question'),
        makeCompactionBlock('c1', 'Earlier summary', 'compacted'),
      ],
      currentBlocks: [makeTextBlock('t1', 'New streaming response')],
      isWorking: true,
    })
    const compactionCall = dividerCalls.find((c) => c.summary === 'Earlier summary')
    expect(compactionCall).toBeTruthy()
    expect(compactionCall?.isStreaming).toBe(false)
  })

  it('passes isStreaming=false to CompactionDivider when isWorking=false even if block is in currentBlocks', () => {
    // Agent just finished; blocks not yet flushed. isWorking=false → not streaming.
    renderView({
      blocks: [],
      currentBlocks: [makeCompactionBlock('c1', 'Done summary', 'compacted')],
      isWorking: false,
    })
    expect(dividerCalls[0].isStreaming).toBe(false)
  })

  it('forwards the summary content to CompactionDivider', () => {
    renderView({
      blocks: [makeCompactionBlock('c1', 'Context compacted to this text', 'compacted')],
      currentBlocks: [],
      isWorking: false,
    })
    expect(dividerCalls[0].summary).toBe('Context compacted to this text')
  })
})

// ---------------------------------------------------------------------------
