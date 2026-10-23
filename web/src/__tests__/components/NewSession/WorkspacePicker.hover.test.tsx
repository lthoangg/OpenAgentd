import { afterEach, describe, expect, it } from 'bun:test'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { WorkspacePicker } from '@/components/NewSession/WorkspacePicker'
import { resetHoverIntent } from '@/hooks/use-hover-intent'

afterEach(() => {
  cleanup()
  resetHoverIntent()
})

describe('WorkspacePicker hover', () => {
  it('moves the active folder only when the mouse moves', async () => {
    const user = userEvent.setup()
    render(
      <WorkspacePicker
        workspace="/work/app"
        label="app"
        isChat={false}
        chat={null}
        repositories={[{ path: '/work/app', name: 'app', worktrees: [] }, { path: '/work/docs', name: 'docs', worktrees: [] }]}
        onSelect={() => {}}
        onOpenFolder={() => {}}
      />,
    )
    await user.click(screen.getByRole('button', { name: 'Folder: app. Change folder' }))
    const filter = await screen.findByRole('combobox', { name: 'Filter folders' })
    const active = () => document.getElementById(filter.getAttribute('aria-activedescendant') ?? '')?.textContent
    const before = active()

    fireEvent.mouseMove(document.body, { clientX: 30, clientY: 30 })
    const docs = screen.getByRole('option', { name: 'docs' })
    fireEvent.mouseEnter(docs, { clientX: 30, clientY: 30 })
    fireEvent.mouseMove(docs, { clientX: 30, clientY: 30 })
    expect(active()).toBe(before)

    fireEvent.mouseMove(docs, { clientX: 31, clientY: 33 })
    expect(active()).toBe('docs')
  })
})
