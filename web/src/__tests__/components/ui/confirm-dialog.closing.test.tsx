/**
 * A caller's title usually names the thing being confirmed, and the caller
 * forgets that thing as the dialog closes. The dialog is still on screen
 * while it fades out, so it keeps the words it opened with: "Delete Alpha?"
 * must not turn into "Delete group?" on the way out.
 */
import { afterEach, describe, expect, it } from 'bun:test'
import { cleanup, render, screen } from '@testing-library/react'

import { ConfirmDialog } from '@/components/ui/confirm-dialog'

afterEach(cleanup)

function Confirm({ name }: { name: string | null }) {
  return (
    <ConfirmDialog
      open={name !== null}
      onOpenChange={() => {}}
      title={`Delete ${name ?? 'group'}?`}
      description={name ? `${name} is removed from 2 workspaces.` : undefined}
      confirmLabel={name ? `Delete ${name}` : 'Delete'}
      onConfirm={() => {}}
    />
  )
}

describe('ConfirmDialog while it closes', () => {
  it('keeps the title, description and action it opened with', () => {
    const view = render(<Confirm name="Alpha" />)
    expect(screen.getByText('Delete Alpha?')).toBeTruthy()

    view.rerender(<Confirm name={null} />)

    expect(screen.queryByText('Delete group?')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Delete' })).toBeNull()
    // Still fading out: the words are the ones it opened with.
    expect(screen.getByText('Delete Alpha?')).toBeTruthy()
    expect(screen.getByText('Alpha is removed from 2 workspaces.')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Delete Alpha', hidden: true })).toBeTruthy()
  })

  it('shows new words when it opens again for something else', () => {
    const view = render(<Confirm name="Alpha" />)
    view.rerender(<Confirm name={null} />)
    view.rerender(<Confirm name="Beta" />)
    expect(screen.getByText('Delete Beta?')).toBeTruthy()
    expect(screen.queryByText('Delete Alpha?')).toBeNull()
  })
})
