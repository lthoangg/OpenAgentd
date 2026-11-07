/**
 * On a phone the filter of Agents, Skills and MCP servers stays pinned at
 * the top while the list scrolls, as the Providers filter does.
 */
import { describe, expect, it, mock } from 'bun:test'
import { render, screen } from '@testing-library/react'

mock.module('@/hooks/use-is-phone', () => ({ useIsPhone: () => true }))
mock.module('@tanstack/react-router', () => ({}))

import { SettingsListView } from '@/components/settings/SettingsListView'

describe('SettingsListView on a phone', () => {
  it('pins the filter at the top of the page', () => {
    render(
      <SettingsListView
        title="Skills"
        description="Manage skills."
        newLabel="New skill"
        onNew={() => {}}
        filterPlaceholder="Filter skills…"
        rows={[{ key: 'a', title: 'alpha', onClick: () => {} }]}
        isLoading={false}
        isError={false}
        emptyTitle="No skills"
        emptyBody="Create a skill."
      />,
    )
    const pinned = screen.getByPlaceholderText('Filter skills…').closest('[data-list-filter]')!
    expect(pinned.className.split(/\s+/)).toEqual(expect.arrayContaining(['sticky', 'top-0']))
  })
})
