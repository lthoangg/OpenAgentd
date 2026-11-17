import { afterEach, describe, expect, it } from 'bun:test'
import { cleanup, render, screen } from '@testing-library/react'

import { FilterBar } from '@/components/Telemetry/FilterBar'

afterEach(cleanup)

const noop = () => {}

function renderLoadingTitle() {
  render(
    <FilterBar
      days={7}
      onDaysChange={noop}
      workspace={null}
      onWorkspaceChange={noop}
      model={null}
      onModelChange={noop}
      session="s1"
      sessionLabel={null}
      onSessionChange={noop}
      facets={null}
      onClear={noop}
      fetching
    />,
  )
  return screen.getByRole('status', { name: "Loading the session's title" })
}

describe('FilterBar session chip', () => {
  it('shows a loading title in a fill the chip itself does not use', () => {
    const skeleton = renderLoadingTitle()
    // The chip is filled with --bg-key; a skeleton in that fill is invisible.
    expect(skeleton.className).not.toContain('bg-(--bg-key)')
    expect(skeleton.className).toMatch(/\bbg-/)
  })
})
