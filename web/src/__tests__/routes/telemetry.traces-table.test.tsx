import { afterEach, describe, expect, it, mock } from 'bun:test'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'

import type { TraceListItem } from '@/api/client'

mock.module('@/hooks/use-mobile', () => ({
  useIsMobile: () => true,
}))

mock.module('@/hooks/use-platform', () => ({
  usePlatform: () => ({ isTauri: true, os: 'ios' }),
}))

mock.module('@/lib/haptics', () => ({
  mediumHapticFeedback: mock(() => undefined),
}))

import { TracesTable } from '@/routes/telemetry/traces/TracesTable'

const trace: TraceListItem = {
  trace_id: 'trace-1234567890',
  span_id: 'span-1',
  run_id: null,
  session_id: 'session-1',
  agent_name: 'lead',
  provider: 'openai',
  model: 'gpt',
  provider_model: 'openai:gpt',
  start_ms: Date.now(),
  end_ms: Date.now() + 100,
  duration_ms: 100,
  input_tokens: 10,
  output_tokens: 20,
  cached_tokens: 5,
  estimated_cost_usd: 0.001,
  llm_calls: 1,
  tool_calls: 0,
  error: false,
}

afterEach(cleanup)

describe('TracesTable', () => {
  it('clears a stale trace long-press timer when touch starts again', () => {
    const originalClearTimeout = window.clearTimeout
    const clearTimeout = mock((...args: unknown[]) => originalClearTimeout(args[0] as number | undefined))
    window.clearTimeout = clearTimeout as typeof window.clearTimeout

    try {
      render(<TracesTable traces={[trace]} onSelect={() => {}} embedded />)
      const row = screen.getByRole('button', { name: /open trace/i })

      fireEvent.pointerDown(row, { pointerType: 'touch', clientX: 10, clientY: 10 })
      fireEvent.pointerDown(row, { pointerType: 'touch', clientX: 20, clientY: 20 })

      expect(clearTimeout).toHaveBeenCalledTimes(1)
    } finally {
      window.clearTimeout = originalClearTimeout
    }
  })
})
