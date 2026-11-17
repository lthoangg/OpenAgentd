/**
 * The phone's run bar above the composer: what step the agent is on and for
 * how long (mockup J4 4.1). Only while the lead agent is working.
 */
import { afterEach, describe, expect, it, mock } from 'bun:test'
import { act, cleanup, render, screen } from '@testing-library/react'

mock.module('@/hooks/use-is-phone', () => ({ useIsPhone: () => true }))

import { RunBar, runBarLabel } from '@/components/composer/RunBar'
import { useAgentStore } from '@/stores/useAgentStore'
import { useDisplayPrefsStore } from '@/stores/useDisplayPrefsStore'
import { runOf } from '@/stores/useAgentStore/run-state'

afterEach(() => {
  cleanup()
  useAgentStore.setState({ leadName: null, agentStreams: {}, sessionRun: runOf(false), pinnedPrompt: null })
  useDisplayPrefsStore.setState({ transcriptStyle: 'detailed' })
})

describe('runBarLabel', () => {
  it('counts the steps and the time as m:ss', () => {
    expect(runBarLabel(0, 4_000)).toBe('Running · 0:04')
    expect(runBarLabel(7, 192_000)).toBe('Running · step 7 · 3:12')
  })

  it('in Simple says Working, as the fold in the transcript does, with the time and no step', () => {
    expect(runBarLabel(0, 4_000, true)).toBe('Working · 0:04')
    expect(runBarLabel(7, 192_000, true)).toBe('Working · 3:12')
  })
})

describe('RunBar', () => {
  const stream = (status: string, tools: number) => ({
    blocks: [],
    currentBlocks: Array.from({ length: tools }, (_, i) => ({ id: `t${i}`, type: 'tool', content: '' })),
    currentText: '',
    currentThinking: '',
    status,
    usage: { promptTokens: 0, completionTokens: 0, cachedTokens: 0 },
    _turnStartedAt: Date.now() - 65_000,
  })

  it('shows the step and elapsed time while working', () => {
    useAgentStore.setState({ leadName: 'lead', sessionRun: runOf(true), agentStreams: { lead: stream('working', 3) as never } })
    render(<RunBar />)
    expect(screen.getByText(/^Running · step 3 · 1:0\d$/)).toBeTruthy()
  })

  it('shows Working and the elapsed time with the Detail setting on Simple', () => {
    useDisplayPrefsStore.setState({ transcriptStyle: 'reader' })
    useAgentStore.setState({ leadName: 'lead', sessionRun: runOf(true), agentStreams: { lead: stream('working', 3) as never } })
    render(<RunBar />)
    expect(screen.getByText(/^Working · 1:0\d$/)).toBeTruthy()
    expect(screen.queryByText(/step/)).toBeNull()
  })

  it('is gone when the agent is not working', () => {
    useAgentStore.setState({ leadName: 'lead', sessionRun: runOf(true), agentStreams: { lead: stream('working', 1) as never } })
    const { container } = render(<RunBar />)
    act(() => { useAgentStore.setState({ sessionRun: runOf(false), agentStreams: { lead: stream('idle', 1) as never } }) })
    expect(container.textContent).toBe('')
  })

  describe('counts every tool call of the running turn, wherever its blocks sit', () => {
    const user = (id: string) => ({ id, type: 'user', content: 'go' })
    const tool = (id: string) => ({ id, type: 'tool', content: '' })
    const text = (id: string) => ({ id, type: 'text', content: 'done' })
    const compaction = (id: string) => ({ id, type: 'compaction', content: 'summary' })
    const working = (blocks: unknown[], currentBlocks: unknown[]) => ({ ...stream('working', 0), blocks, currentBlocks })
    const renderWith = (blocks: unknown[], currentBlocks: unknown[]) => {
      useAgentStore.setState({ leadName: 'lead', sessionRun: runOf(true), agentStreams: { lead: working(blocks, currentBlocks) as never } })
      render(<RunBar />)
    }

    it('after a resume moved the persisted calls into the stored rows', () => {
      renderWith([user('u1'), tool('a'), tool('b'), tool('c')], [tool('d')])
      expect(screen.getByText(/^Running · step 4 · /)).toBeTruthy()
    })

    it('after a reload, with every call so far in the stored rows', () => {
      renderWith([user('u1'), tool('a'), tool('b'), tool('c'), tool('d'), tool('e')], [])
      expect(screen.getByText(/^Running · step 5 · /)).toBeTruthy()
    })

    it('across a compaction partway through the turn', () => {
      renderWith([user('u1'), tool('a'), tool('b'), compaction('c1')], [tool('c')])
      expect(screen.getByText(/^Running · step 3 · /)).toBeTruthy()
    })

    it('not the calls of an earlier, finished turn', () => {
      renderWith([user('u1'), tool('a'), tool('b'), text('t1')], [user('u2'), tool('c')])
      expect(screen.getByText(/^Running · step 1 · /)).toBeTruthy()
    })
  })

  describe("times the running turn from its prompt, not from the stream's own start mark", () => {
    // A reload or a resume sets the stream's mark to the moment it reconnected.
    const reconnectedJustNow = () => Date.now()
    const ago = (ms: number) => new Date(Date.now() - ms)
    const user = (id: string, at?: Date) => ({ id, type: 'user', content: 'go', ...(at ? { timestamp: at } : {}) })
    const tool = (id: string) => ({ id, type: 'tool', content: '' })
    const compaction = (id: string) => ({ id, type: 'compaction', content: 'summary' })
    const renderWith = (blocks: unknown[], currentBlocks: unknown[], turnStartedAt: number | null = reconnectedJustNow()) => {
      const lead = { ...stream('working', 0), blocks, currentBlocks, _turnStartedAt: turnStartedAt }
      useAgentStore.setState({ leadName: 'lead', sessionRun: runOf(true), agentStreams: { lead: lead as never } })
      render(<RunBar />)
    }

    it('after a reload, with the prompt in the stored rows', () => {
      renderWith([user('u1', ago(192_000)), tool('a'), tool('b')], [])
      expect(screen.getByText(/^Running · step 2 · 3:1\d$/)).toBeTruthy()
    })

    it('after a reload whose loaded page starts past the prompt, from the pinned prompt', () => {
      useAgentStore.setState({ pinnedPrompt: user('u1', ago(192_000)) as never })
      renderWith([tool('a'), tool('b')], [])
      expect(screen.getByText(/^Running · step 2 · 3:1\d$/)).toBeTruthy()
    })

    it('after a resume, with the prompt stored and new calls live', () => {
      renderWith([user('u1', ago(192_000)), tool('a')], [tool('b')])
      expect(screen.getByText(/^Running · step 2 · 3:1\d$/)).toBeTruthy()
    })

    it('across a compaction partway through the turn', () => {
      renderWith([user('u1', ago(192_000)), tool('a'), compaction('c1'), tool('b')], [])
      expect(screen.getByText(/^Running · step 2 · 3:1\d$/)).toBeTruthy()
    })

    it("falls back to the stream's mark when the prompt has no time", () => {
      renderWith([user('u1'), tool('a')], [], Date.now() - 65_000)
      expect(screen.getByText(/^Running · step 1 · 1:0\d$/)).toBeTruthy()
    })
  })
})
