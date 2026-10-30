import { afterEach, describe, expect, it } from 'bun:test'
import type { ObservabilitySummary, SessionUsage, SpanDetail } from '@/api/client'
import { dailySeries, headline, modelName, nestSessions, sessionName, sharePct, traceSummary, workspaceName } from '@/components/Telemetry/model'
import { setChatWorkspaceEntry } from '@/utils/workspace'

afterEach(() => setChatWorkspaceEntry(null))

function summary(overrides: Partial<ObservabilitySummary> = {}): ObservabilitySummary {
  return {
    window_start: '2026-05-21T10:00:00Z',
    window_end: '2026-05-24T09:00:00Z',
    sample_ratio: 1,
    totals: {
      turns: 4,
      llm_calls: 6,
      tool_calls: 3,
      input_tokens: 2000,
      output_tokens: 500,
      cached_tokens: 800,
      cache_write_tokens: 0,
      cache_percent: 40,
      estimated_cost_usd: 0.2,
      errors: 1,
    },
    latency_ms: { turn_p50: 1200, turn_p95: 4000, llm_p50: 600, llm_p95: 1500 },
    daily_turns: [
      { day: '2026-05-21', turns: 1, errors: 0, estimated_cost_usd: 0.05 },
      { day: '2026-05-23', turns: 3, errors: 1, estimated_cost_usd: 0.15 },
    ],
    by_model: [],
    cache_by_step: [],
    by_tool: [],
    ...overrides,
  }
}

function span(overrides: Partial<SpanDetail>): SpanDetail {
  return {
    span_id: 's',
    parent_span_id: null,
    trace_id: 't',
    name: 'chat',
    kind: 'INTERNAL',
    start_ms: 1000,
    end_ms: 2000,
    duration_ms: 1000,
    status: 'OK',
    attributes: {},
    ...overrides,
  }
}

function usage(session_id: string, parent_session_id: string | null = null): SessionUsage {
  return {
    session_id,
    workspace: null,
    model: null,
    agent_name: null,
    turns: 1,
    errors: 0,
    input_tokens: 0,
    output_tokens: 0,
    cached_tokens: 0,
    cache_percent: 0,
    estimated_cost_usd: 0,
    last_active_ms: 0,
    parent_session_id,
  }
}

describe('telemetry model', () => {
  it('labels workspaces: unrecorded, chat root, and project basename', () => {
    setChatWorkspaceEntry({ path: '/home/me/.openagentd/chat', name: 'Chat' })
    expect(workspaceName(null)).toBe('Unknown workspace')
    expect(workspaceName('/home/me/.openagentd/chat')).toBe('Chat')
    expect(workspaceName('/home/me/code/site')).toBe('site')
  })

  it('strips the provider from provider:model', () => {
    expect(modelName('openai:gpt-5')).toBe('gpt-5')
    expect(modelName('local-model')).toBe('local-model')
  })

  it('names sessions by title, else by what they were', () => {
    const base = { title: null, deleted: false, parent_session_id: null, agent_name: 'lead' }
    expect(sessionName({ ...base, title: 'Fix login' })).toBe('Fix login')
    expect(sessionName({ ...base, deleted: true })).toBe('Deleted session')
    expect(sessionName({ ...base, parent_session_id: 'p', agent_name: 'explorer' })).toBe('explorer sub-agent')
    expect(sessionName(base)).toBe('Untitled session')
  })

  it('nests sub-agent sessions under their parent across id forms, keeping rank among siblings', () => {
    const lead = '0190a1b2-0000-7000-8000-00000000000a'
    const leadHex = lead.replace(/-/g, '')
    const rows = [
      usage('other'),
      usage('child-b', lead),
      usage(leadHex),
      usage('child-a', lead),
      usage('grandchild', 'child-a'),
      usage('orphan', 'missing-parent'),
    ]
    expect(nestSessions(rows).map(({ row, depth }) => [row.session_id, depth])).toEqual([
      ['other', 0],
      [leadHex, 0],
      ['child-b', 1],
      ['child-a', 1],
      ['grandchild', 2],
      ['orphan', 0],
    ])
  })

  it('keeps sessions whose recorded parents form a cycle', () => {
    const nested = nestSessions([usage('x', 'y'), usage('y', 'x')])
    expect(nested.map(({ row }) => row.session_id).sort()).toEqual(['x', 'y'])
  })

  it('zero-fills every UTC day of the window', () => {
    expect(dailySeries(summary())).toEqual([
      { day: '2026-05-21', turns: 1, failed: 0, cost: 0.05 },
      { day: '2026-05-22', turns: 0, failed: 0, cost: 0 },
      { day: '2026-05-23', turns: 3, failed: 1, cost: 0.15 },
      { day: '2026-05-24', turns: 0, failed: 0, cost: 0 },
    ])
  })

  it('derives failed turns from the daily buckets and spend per turn', () => {
    const h = headline(summary())
    expect(h.failedTurns).toBe(1)
    expect(h.spendPerTurn).toBeCloseTo(0.05)
    expect(headline(summary({ totals: { ...summary().totals, turns: 0 } })).spendPerTurn).toBe(0)
  })

  it('carries streaming speed, zero on backends that do not report it', () => {
    const h = headline(summary({
      latency_ms: { turn_p50: 1200, turn_p95: 4000, llm_p50: 600, llm_p95: 1500, ttft_p50: 700, ttft_p95: 2400 },
      output_tps: { p50: 55, p5: 18 },
    }))
    expect([h.ttftP50, h.ttftP95, h.tpsP50, h.tpsP5]).toEqual([700, 2400, 55, 18])
    const old = headline(summary())
    expect([old.ttftP50, old.ttftP95, old.tpsP50, old.tpsP5]).toEqual([0, 0, 0, 0])
  })

  it('sharePct never returns NaN or exceeds 100', () => {
    expect(sharePct(1, 0)).toBe(0)
    expect(sharePct(0, 10)).toBe(0)
    expect(sharePct(5, 10)).toBe(50)
    expect(sharePct(20, 10)).toBe(100)
  })

  it('summarizes a trace from its turn span and the usage of the rest', () => {
    const s = traceSummary([
      span({
        span_id: 'run',
        name: 'agent_run lead',
        start_ms: 1000,
        end_ms: 5000,
        duration_ms: 4000,
        status: 'ERROR',
        attributes: {
          'gen_ai.agent.name': 'lead',
          'gen_ai.provider.name': 'openai',
          'gen_ai.request.model': 'gpt-5',
          'gen_ai.conversation.id': 'sess-1',
          'openagentd.workspace': '/w/app',
          // The turn span repeats the last call's usage; it must not double count.
          'gen_ai.usage.input_tokens': 999,
        },
      }),
      span({ span_id: 'c1', parent_span_id: 'run', attributes: { 'gen_ai.usage.input_tokens': 100, 'gen_ai.usage.output_tokens': 10, 'gen_ai.usage.estimated_cost_usd': 0.01 } }),
      span({ span_id: 'c2', parent_span_id: 'run', attributes: { 'gen_ai.usage.input_tokens': '200', 'gen_ai.usage.estimated_cost_usd': 0.02 } }),
    ])
    expect(s).toMatchObject({
      startMs: 1000,
      durationMs: 4000,
      agentName: 'lead',
      workspace: '/w/app',
      providerModel: 'openai:gpt-5',
      sessionId: 'sess-1',
      inputTokens: 300,
      outputTokens: 10,
      failed: true,
    })
    expect(s.cost).toBeCloseTo(0.03)
  })

  it('treats runs outside a session and pre-v3 turns as unknown', () => {
    const s = traceSummary([
      span({ name: 'agent_run lead', attributes: { 'gen_ai.conversation.id': 'no-session' } }),
    ])
    expect(s.sessionId).toBeNull()
    expect(s.workspace).toBeNull()
    expect(traceSummary([span({ name: 'title_generation' })]).workspace).toBeUndefined()
  })
})
