import { afterEach, describe, expect, it } from 'bun:test'
import { cleanup, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { WorkspacePicker } from '@/components/NewSession/WorkspacePicker'
import { resetHoverIntent } from '@/hooks/use-hover-intent'

afterEach(() => {
  cleanup()
  resetHoverIntent()
})

describe('WorkspacePicker checkout kinds', () => {
  it('lists worktrees, then subfolders as folders, and leaves out checkouts that are gone', async () => {
    const user = userEvent.setup()
    render(
      <WorkspacePicker
        workspace="/work/app"
        label="app"
        isChat={false}
        chat={null}
        repositories={[{
          path: '/work/app',
          name: 'app',
          worktrees: [
            { path: '/work/app/web', name: 'web', managed: false, kind: 'folder' },
            { path: '/wt/fix', name: 'fix', managed: true, kind: 'worktree' },
            { path: '/wt/side', name: 'side', managed: false, kind: 'worktree', external: true },
            { path: '/wt/gone', name: 'gone', managed: true, kind: 'worktree', missing: true },
          ],
        }]}
        onSelect={() => {}}
        onOpenFolder={() => {}}
      />,
    )
    await user.click(screen.getByRole('button', { name: 'Folder: app. Change folder' }))
    const list = await screen.findByRole('listbox', { name: 'Folders' })
    const rows = within(list).getAllByRole('option').filter((row) => row.hasAttribute('data-picker-kind'))
    expect(rows.map((row) => [row.textContent, row.getAttribute('data-picker-kind')])).toEqual([
      ['app', 'repo'],
      ['fix', 'worktree'],
      ['side', 'worktree'],
      ['web', 'folder'],
    ])
  })
})
