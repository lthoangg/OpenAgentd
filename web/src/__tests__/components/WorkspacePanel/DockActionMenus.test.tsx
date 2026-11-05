/**
 * The Review panel's row action surfaces: the discard confirmation is a
 * confirm dialog (title "Discard changes?", Cancel first, the destructive
 * action never the default, no ×), and the phone's file sheet marks the row
 * that opens that dialog with "…", as the desktop menu does.
 */
import { afterEach, describe, expect, it, mock } from 'bun:test'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'

mock.module('lucide-react', () => new Proxy({}, { get: () => () => null }))

import { DockActionMenus, type DockActionMenusProps } from '@/components/WorkspacePanel/DockActionMenus'
import type { ChangedFileInfo } from '@/components/WorkspacePanel/diff-helpers'

afterEach(cleanup)

const file: ChangedFileInfo = { path: 'src/app.ts', status: 'M', additions: 1, deletions: 1 } as ChangedFileInfo

function renderMenus(overrides: Partial<DockActionMenusProps> = {}) {
  const noop = () => {}
  const props: DockActionMenusProps = {
    mobileFileActions: null,
    setMobileFileActions: noop,
    desktopFileActions: null,
    setDesktopFileActions: noop,
    mobileCommitActions: null,
    setMobileCommitActions: noop,
    desktopCommitActions: null,
    setDesktopCommitActions: noop,
    isLatestCommit: false,
    gitActionPending: false,
    hasWorkingDiff: () => true,
    onOpenFile: noop,
    onOpenDiffTab: noop,
    onOpenCommitTab: noop,
    onUndoCommit: noop,
    onRevertCommit: noop,
    discardTarget: null,
    setDiscardTarget: noop,
    discarding: false,
    onConfirmDiscard: noop,
    ...overrides,
  }
  return render(<DockActionMenus {...props} />)
}

describe('discard confirmation', () => {
  it('is "Discard changes?" with Cancel then the danger action, and no ×', () => {
    renderMenus({ discardTarget: file })
    const dialog = screen.getByRole('dialog', { name: 'Discard changes?' })

    expect(dialog.querySelector('[data-close-button]')).toBeNull()
    const buttons = within(dialog).getAllByRole('button').map((button) => button.textContent)
    expect(buttons).toEqual(['Cancel', 'Discard changes'])
    expect(within(dialog).getByRole('button', { name: 'Discard changes' }).getAttribute('data-variant')).toBe('danger')
    expect(dialog.textContent).toContain('src/app.ts')
  })

  it('never makes the destructive action the default: Cancel takes focus', async () => {
    renderMenus({ discardTarget: file })
    const dialog = screen.getByRole('dialog', { name: 'Discard changes?' })
    // Focus lands on the next frame.
    await waitFor(() => expect(document.activeElement?.textContent).toBe('Cancel'))
    expect(dialog.contains(document.activeElement)).toBe(true)
  })

  it('Cancel dismisses without discarding; the action confirms', () => {
    const setDiscardTarget = mock((..._args: unknown[]) => {})
    const onConfirmDiscard = mock(() => {})
    renderMenus({ discardTarget: file, setDiscardTarget, onConfirmDiscard })

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(setDiscardTarget).toHaveBeenCalledWith(null)
    expect(onConfirmDiscard).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: 'Discard changes' }))
    expect(onConfirmDiscard).toHaveBeenCalledTimes(1)
  })

  it('says "Discarding…" while it runs and holds both buttons', () => {
    renderMenus({ discardTarget: file, discarding: true })
    expect((screen.getByRole('button', { name: 'Cancel' }) as HTMLButtonElement).disabled).toBe(true)
    expect((screen.getByRole('button', { name: 'Discarding…' }) as HTMLButtonElement).disabled).toBe(true)
  })
})

describe('file actions', () => {
  it('mark Discard changes… with the ellipsis on the phone sheet, as on the desktop menu: it opens the dialog', () => {
    const setDiscardTarget = mock((..._args: unknown[]) => {})
    const first = renderMenus({ mobileFileActions: file, setDiscardTarget })
    const sheet = screen.getByRole('dialog')
    fireEvent.click(within(sheet).getByRole('button', { name: 'Discard changes…' }))
    expect(setDiscardTarget).toHaveBeenCalledWith(file)
    first.unmount()

    renderMenus({ desktopFileActions: { file, x: 10, y: 10 } })
    expect(screen.getByRole('menuitem', { name: 'Discard changes…' })).toBeTruthy()
  })

  it('keeps one × on the phone sheet (the shared CloseButton) and clears the title of it', () => {
    renderMenus({ mobileFileActions: file })
    const sheet = screen.getByRole('dialog')
    expect(sheet.querySelectorAll('[data-close-button]')).toHaveLength(1)
    expect(within(sheet).getByRole('button', { name: 'Close' })).toBeTruthy()
    expect(sheet.querySelector('h2')?.className).toContain('pr-8')
  })
})
