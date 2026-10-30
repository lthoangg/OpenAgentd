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

  it('wraps a long title beside its chips on phones, and moves trailing chips under it', () => {
    render(
      <SettingsListView
        title="MCP"
        description="Servers"
        newLabel="New server"
        onNew={() => {}}
        filterPlaceholder="Filter"
        rows={[
          {
            key: 'github',
            title: 'a-really-long-mcp-server-name',
            badge: 'subagent',
            trailing: <span data-testid="trailing">stdio · Connected</span>,
            onClick: () => {},
          },
        ]}
        isLoading={false}
        isError={false}
        emptyTitle="None"
        emptyBody="None"
      />,
    )

    const title = screen.getByText('a-really-long-mcp-server-name')
    expect(title.className).toContain('sm:truncate')
    expect(title.className.split(' ')).not.toContain('truncate')
    expect((title.parentElement as HTMLElement).className).toContain('flex-wrap')
    const row = screen.getByRole('button', { name: /a-really-long/ })
    expect(row.className).toContain('max-sm:flex-wrap')
    expect((screen.getByTestId('trailing').parentElement as HTMLElement).className).toContain('max-sm:w-full')
  })
})
