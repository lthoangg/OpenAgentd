import { afterEach, describe, expect, it } from 'bun:test'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { WorkspacePicker } from '@/components/NewSession/WorkspacePicker'
import { resetHoverIntent } from '@/hooks/use-hover-intent'

afterEach(() => {
  cleanup()
  resetHoverIntent()
})

describe('WorkspacePicker empty filter', () => {
  it('says "No folder matches" as a compact empty state, and still offers Open workspace…', async () => {
    const user = userEvent.setup()
    render(
      <WorkspacePicker
        workspace="/work/app"
        label="app"
        isChat={false}
        chat={null}
        repositories={[{ path: '/work/app', name: 'app', worktrees: [] }]}
        onSelect={() => {}}
        onOpenFolder={() => {}}
      />,
    )
    await user.click(screen.getByRole('button', { name: 'Folder: app. Change folder' }))
    fireEvent.change(await screen.findByRole('combobox', { name: 'Filter folders' }), { target: { value: 'zzz' } })

    const list = screen.getByRole('listbox', { name: 'Folders' })
    // Sentence case, no trailing period, at row scale.
    const title = within(list).getByText('No folder matches')
    expect(title.closest('[data-empty-state="compact"]')).toBeTruthy()
    expect(within(list).queryByText('No folder matches.')).toBeNull()
    expect(within(list).getByRole('option', { name: 'Open workspace…' })).toBeTruthy()
  })
})
