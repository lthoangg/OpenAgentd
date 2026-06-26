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
  it('keeps settings list rows touch-sized and keyboard-focusable', () => {
    renderList()

    const row = screen.getByRole('button', { name: /lead/i })
    expect(row.className).toContain('min-h-11')
    expect(row.className).toContain('focus-visible:ring-3')
  })
})
