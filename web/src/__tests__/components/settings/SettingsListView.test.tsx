import { describe, expect, it, mock } from 'bun:test'
import { render, screen } from '@testing-library/react'
import { SettingsListView } from '@/components/settings/SettingsListView'

// SettingsListView no longer uses router Links; no mock needed.
mock.module('@tanstack/react-router', () => ({}))

function renderList() {
  render(
    <SettingsListView
      title="Agents"
      description="Manage agents."
      newLabel="New agent"
      onNew={() => {}}
      filterPlaceholder="Filter agents"
      rows={[
        {
          key: 'lead',
          title: 'lead',
          description: 'Primary agent',
          onClick: () => {},
        },
      ]}
      isLoading={false}
      isError={false}
      emptyTitle="No agents"
      emptyBody="Create an agent."
    />,
  )
}

describe('SettingsListView', () => {
  it('renders keyboard-focusable row buttons', () => {
    renderList()

    const row = screen.getByRole('button', { name: /lead/i })
    expect(row).toBeTruthy()
    // Verify it's focusable (interactive button element)
    expect(row.tagName).toBe('BUTTON')
  })
})
