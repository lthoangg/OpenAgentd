/**
 * On a phone Usage keeps the time range in the bar and gathers the other
 * filters in a sheet (mockup J9).
 */
import '@testing-library/jest-dom'
import { afterEach, describe, expect, it, mock } from 'bun:test'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'

mock.module('@/hooks/use-is-phone', () => ({ useIsPhone: () => true }))

const { FilterBar } = await import('@/components/Telemetry/FilterBar')

afterEach(cleanup)

describe('FilterBar on a phone', () => {
  it('opens the filters in a sheet, counting the ones set', () => {
    render(
      <FilterBar
        days={7}
        onDaysChange={() => {}}
        workspace="/repo/app"
        onWorkspaceChange={() => {}}
        model={null}
        onModelChange={() => {}}
        session={null}
        sessionLabel={null}
        onSessionChange={() => {}}
        facets={{ workspaces: ['/repo/app'], models: [] }}
        onClear={() => {}}
        fetching={false}
        errorsOnly
        onErrorsOnlyChange={() => {}}
      />,
    )
    expect(screen.getByRole('radiogroup', { name: 'Time range' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Failed only' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Filters · 2' }))
    expect(document.querySelector('[data-usage-filters]')).not.toBeNull()
    expect(screen.getByRole('button', { name: 'Failed only' })).toBeInTheDocument()
  })
})
