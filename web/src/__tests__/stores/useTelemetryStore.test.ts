import { afterEach, describe, expect, it } from 'bun:test'

import { isTelemetryRange, openTelemetry, useTelemetryStore } from '@/stores/useTelemetryStore'
import { useSettingsStore } from '@/stores/useSettingsStore'
import { useUIStore } from '@/stores/useUIStore'

afterEach(() => {
  useTelemetryStore.setState({ days: 7, workspace: null, model: null, session: null, errorsOnly: false, traceId: null, spanId: null })
  useUIStore.setState({ telemetryOpen: false, schedulerOpen: false })
  useSettingsStore.getState().closeSettings()
  localStorage.removeItem('oa.telemetry.v1')
})

describe('useTelemetryStore', () => {
  it('openTelemetry opens the overlay on the requested range and trace', () => {
    openTelemetry({ days: 30, traceId: 'trace-1' })
    expect(useUIStore.getState().telemetryOpen).toBe(true)
    expect(useTelemetryStore.getState()).toMatchObject({ days: 30, traceId: 'trace-1' })
  })

  it('openTelemetry without a trace lands on the overview but keeps filters', () => {
    useTelemetryStore.setState({ workspace: '/w/app', traceId: 'old-trace' })
    openTelemetry()
    expect(useTelemetryStore.getState()).toMatchObject({ workspace: '/w/app', traceId: null })
  })

  it('openTelemetry, openTrace and closeTrace reset the open span', () => {
    useTelemetryStore.setState({ traceId: 'trace-1', spanId: 'span-1' })
    openTelemetry({ traceId: 'trace-2' })
    expect(useTelemetryStore.getState()).toMatchObject({ traceId: 'trace-2', spanId: null })

    useTelemetryStore.getState().selectSpan('span-2')
    useTelemetryStore.getState().openTrace('trace-3')
    expect(useTelemetryStore.getState()).toMatchObject({ traceId: 'trace-3', spanId: null })

    useTelemetryStore.getState().selectSpan('span-3')
    useTelemetryStore.getState().closeTrace()
    expect(useTelemetryStore.getState()).toMatchObject({ traceId: null, spanId: null })

    useTelemetryStore.setState({ traceId: 'trace-4', spanId: 'span-4' })
    openTelemetry()
    expect(useTelemetryStore.getState()).toMatchObject({ traceId: null, spanId: null })
  })

  it('selectSpan opens and clears a span without touching the trace', () => {
    useTelemetryStore.getState().openTrace('trace-1')
    useTelemetryStore.getState().selectSpan('span-1')
    expect(useTelemetryStore.getState()).toMatchObject({ traceId: 'trace-1', spanId: 'span-1' })
    useTelemetryStore.getState().selectSpan(null)
    expect(useTelemetryStore.getState()).toMatchObject({ traceId: 'trace-1', spanId: null })
  })

  it('stepBack leaves the open span first, then the trace, and reports false when nothing is open', () => {
    useTelemetryStore.setState({ traceId: 'trace-1', spanId: 'span-1' })
    expect(useTelemetryStore.getState().stepBack()).toBe(true)
    expect(useTelemetryStore.getState()).toMatchObject({ traceId: 'trace-1', spanId: null })

    expect(useTelemetryStore.getState().stepBack()).toBe(true)
    expect(useTelemetryStore.getState()).toMatchObject({ traceId: null, spanId: null })

    expect(useTelemetryStore.getState().stepBack()).toBe(false)
  })

  it('does not persist the open span', () => {
    useTelemetryStore.setState({ days: 30, traceId: 'trace-1', spanId: 'span-1' })
    const saved = JSON.parse(localStorage.getItem('oa.telemetry.v1') ?? '{}') as { state?: Record<string, unknown> }
    expect(saved.state).toEqual({ days: 30 })
  })

  it('openTelemetry closes Settings (overlays are mutually exclusive)', () => {
    useSettingsStore.getState().openSettings()
    openTelemetry()
    expect(useSettingsStore.getState().open).toBe(false)
    expect(useUIStore.getState().telemetryOpen).toBe(true)
  })

  it('opening Settings closes telemetry', () => {
    openTelemetry()
    useSettingsStore.getState().openSettings()
    expect(useUIStore.getState().telemetryOpen).toBe(false)
  })

  it('clearFilters resets workspace, model, session, and failed-only', () => {
    useTelemetryStore.setState({ workspace: '/w/app', model: 'openai:gpt-5', session: 'sess-1', errorsOnly: true, days: 30 })
    useTelemetryStore.getState().clearFilters()
    expect(useTelemetryStore.getState()).toMatchObject({ workspace: null, model: null, session: null, errorsOnly: false, days: 30 })
  })

  it('persists only the range', () => {
    useTelemetryStore.setState({ days: 90, workspace: '/w/app', traceId: 'trace-1' })
    const saved = JSON.parse(localStorage.getItem('oa.telemetry.v1') ?? '{}') as { state?: Record<string, unknown> }
    expect(saved.state).toEqual({ days: 90 })
  })

  it('isTelemetryRange accepts only the offered windows', () => {
    expect([1, 7, 30, 90].every(isTelemetryRange)).toBe(true)
    expect(isTelemetryRange(14)).toBe(false)
    expect(isTelemetryRange('7')).toBe(false)
  })
})
