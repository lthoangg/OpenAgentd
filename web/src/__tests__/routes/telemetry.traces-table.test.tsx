import { afterEach, describe, expect, it, mock } from 'bun:test'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { TraceListItem } from '@/api/client'

afterEach(cleanup)

mock.module('lucide-react', () => new Proxy({}, { get: () => () => null }))

mock.module('@/hooks/use-mobile', () => ({
  useIsMobile: () => false,
}))

mock.module('@/hooks/use-platform', () => ({
  usePlatform: () => ({ isTauri: false, os: null, isMacOverlay: false }),
}))

import { TracesTable } from '@/routes/telemetry/traces/TracesTable'

function trace(overrides: Partial<TraceListItem> = {}): TraceListItem {
  return {
    trace_id: '0x' + '1'.repeat(32),
    span_id: '0x' + 'a'.repeat(16),
    run_id: 'run-1',
    session_id: 'sess-a',
    agent_name: 'lead',
    provider: 'openai',
    model: 'gpt-test',
    provider_model: 'openai:gpt-test',
    start_ms: Date.now(),
    end_ms: Date.now() + 1000,
    duration_ms: 1000,
    input_tokens: 1000,
    output_tokens: 100,
    cached_tokens: 250,
    estimated_cost_usd: 0.001,
    llm_calls: 1,
    tool_calls: 0,
    error: false,
    ...overrides,
  }
}

describe('TracesTable', () => {
  it('renders the shared uppercase card header row', () => {
    render(<TracesTable traces={[trace()]} onSelect={() => {}} />)

    const whenHeader = screen.getByText('When')
    const headerRow = whenHeader.closest('tr')
    expect(headerRow?.className).toContain('bg-(--bg-key)/25')
    expect(whenHeader.className).toContain('uppercase')
    expect(whenHeader.className).toContain('tracking-wider')
  })

  it('wraps a standalone (non-embedded) table in a card border', () => {
    render(<TracesTable traces={[trace()]} onSelect={() => {}} />)

    const table = screen.getByRole('table')
    const wrapper = table.parentElement
    expect(wrapper?.className).toContain('rounded')
    expect(wrapper?.className).toContain('border')
    expect(wrapper?.className).toContain('bg-(--bg-card)')
  })

  it('renders without an outer wrapper when embedded', () => {
    render(<TracesTable traces={[trace()]} onSelect={() => {}} embedded />)

    const table = screen.getByRole('table')
    // Embedded mode is used inside TracesSection's own SectionCard, so the
    // table's direct parent should be whatever the test host renders — not
    // a duplicate rounded/border wrapper.
    expect(table.parentElement?.className ?? '').not.toContain('rounded')
  })

  it('uses virtual rows only for the embedded scroll-paginated list', () => {
    const traces = Array.from({ length: 100 }, (_, index) =>
      trace({
        trace_id: `0x${String(index).padStart(32, '0')}`,
        span_id: `0x${String(index).padStart(16, '0')}`,
      }),
    )
    const { rerender } = render(<TracesTable traces={traces} onSelect={() => {}} embedded />)

    // The table only enables its virtual row range when TracesSection supplies
    // its real scroll element; direct embedded renders stay deterministic for
    // DOM-only tests while retaining the virtualized row container.
    expect(screen.getByTestId('virtual-trace-rows')).toBeTruthy()
    expect(screen.getAllByRole('button', { name: /Open trace/ })).toHaveLength(traces.length)

    rerender(<TracesTable traces={traces} onSelect={() => {}} />)
    expect(screen.queryByTestId('virtual-trace-rows')).toBeNull()
    expect(screen.getAllByRole('button', { name: /Open trace/ })).toHaveLength(traces.length)
  })

  it('shows a status pill for errored traces and a plain label otherwise', () => {
    render(
      <TracesTable
        traces={[
          trace({ error: true }),
          trace({ trace_id: '0x' + '2'.repeat(32), span_id: '0x' + 'b'.repeat(16), error: false }),
        ]}
        onSelect={() => {}}
      />,
    )

    expect(screen.getByText('error')).toBeTruthy()
    expect(screen.getByText('ok')).toBeTruthy()
  })

  it('opens the row context menu on right-click and closes it on backdrop click', () => {
    render(<TracesTable traces={[trace()]} onSelect={() => {}} />)

    const row = screen.getByRole('button', { name: /Open trace/ })
    fireEvent.contextMenu(row, { clientX: 40, clientY: 60 })

    const menu = screen.getByRole('menu')
    expect(menu).toBeTruthy()
    expect(screen.getByRole('menuitem', { name: /Open trace/ })).toBeTruthy()
    expect(screen.getByRole('menuitem', { name: /Copy trace ID/ })).toBeTruthy()

    // Clicking the fixed backdrop closes the menu.
    fireEvent.click(menu.parentElement!)
    expect(screen.queryByRole('menu')).toBeNull()
  })

  it('selects the trace when "Open trace" is chosen from the context menu', () => {
    const onSelect = mock()
    const t = trace()
    render(<TracesTable traces={[t]} onSelect={onSelect} />)

    const row = screen.getByRole('button', { name: /Open trace/ })
    fireEvent.contextMenu(row, { clientX: 10, clientY: 10 })
    fireEvent.click(screen.getByRole('menuitem', { name: /Open trace/ }))

    expect(onSelect).toHaveBeenCalledWith(t.trace_id)
    expect(screen.queryByRole('menu')).toBeNull()
  })

  it('copies the full trace id to the clipboard from the context menu', async () => {
    let copied = ''
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText: async (text: string) => { copied = text } },
      writable: true,
      configurable: true,
    })

    const t = trace()
    render(<TracesTable traces={[t]} onSelect={() => {}} />)

    const row = screen.getByRole('button', { name: /Open trace/ })
    fireEvent.contextMenu(row, { clientX: 10, clientY: 10 })
    fireEvent.click(screen.getByRole('menuitem', { name: /Copy trace ID/ }))

    await Promise.resolve()
    expect(copied).toBe(t.trace_id)
  })

  it('opens the trace when Enter is pressed on a focused row', () => {
    const onSelect = mock()
    const t = trace()
    render(<TracesTable traces={[t]} onSelect={onSelect} />)

    const row = screen.getByRole('button', { name: /Open trace/ })
    fireEvent.keyDown(row, { key: 'Enter' })

    expect(onSelect).toHaveBeenCalledWith(t.trace_id)
  })

  it('falls back to em-dash placeholders when session id and agent name are absent', () => {
    render(
      <TracesTable
        traces={[trace({ session_id: null, agent_name: null })]}
        onSelect={() => {}}
      />,
    )

    expect(screen.getAllByText('—').length).toBeGreaterThan(0)
  })
})
