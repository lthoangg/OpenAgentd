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

const rows = () => Array.from(document.querySelectorAll<HTMLElement>('[data-action-sheet-item]'))

const file: ChangedFileInfo = { path: 'src/app.ts', status: 'M', additions: 1, deletions: 1 } as ChangedFileInfo

function renderMenus(overrides: Partial<DockActionMenusProps> = {}) {
  const noop = () => {}
  const props: DockActionMenusProps = {
    workspace: '/Users/me/repo/',
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

  it('is the app\'s action sheet on a phone: the path as its title, no ×, Discard last in red', () => {
    const setMobileFileActions = mock((..._args: unknown[]) => {})
    const onOpenFile = mock((..._args: unknown[]) => {})
    renderMenus({ mobileFileActions: file, setMobileFileActions, onOpenFile })
    const sheet = screen.getByRole('dialog', { name: 'src/app.ts' })
    expect(sheet.querySelector('[data-action-sheet]')).toBeTruthy()
    expect(sheet.querySelector('[data-close-button]')).toBeNull()
    expect(rows().map((row) => row.textContent)).toEqual(['Open diff in tab', 'Open file', 'Copy path', 'Copy relative path', 'Discard changes…'])
    expect(rows().at(-1)!.className).toContain('text-(--color-error)')
    fireEvent.click(rows()[1]!)
    expect(setMobileFileActions).toHaveBeenCalledWith(null)
    expect(onOpenFile).toHaveBeenCalledWith('src/app.ts')
  })

  it('leaves out Open file for a deleted file and Open diff when there is no working diff', () => {
    renderMenus({ mobileFileActions: { ...file, status: 'D' }, hasWorkingDiff: () => false })
    expect(rows().map((row) => row.textContent)).toEqual(['Copy path', 'Copy relative path', 'Discard changes…'])
  })

  describe('copying the path', () => {
    const writes: string[] = []
    const original = Object.getOwnPropertyDescriptor(navigator, 'clipboard')
    const stubClipboard = () => {
      writes.length = 0
      Object.defineProperty(navigator, 'clipboard', {
        configurable: true,
        value: { writeText: (text: string) => { writes.push(text); return Promise.resolve() } },
      })
    }
    afterEach(() => {
      if (original) Object.defineProperty(navigator, 'clipboard', original)
      else Reflect.deleteProperty(navigator, 'clipboard')
    })

    it('copies the absolute path and the relative one from the right-click menu', () => {
      stubClipboard()
      const setDesktopFileActions = mock((..._args: unknown[]) => {})
      renderMenus({ desktopFileActions: { file, x: 10, y: 10 }, setDesktopFileActions })
      fireEvent.click(screen.getByRole('menuitem', { name: 'Copy path' }))
      fireEvent.click(screen.getByRole('menuitem', { name: 'Copy relative path' }))
      expect(writes).toEqual(['/Users/me/repo/src/app.ts', 'src/app.ts'])
      expect(setDesktopFileActions).toHaveBeenCalledWith(null)
    })

    it('copies the same two from the phone sheet', () => {
      stubClipboard()
      renderMenus({ mobileFileActions: file })
      fireEvent.click(rows().find((row) => row.textContent === 'Copy path')!)
      expect(writes).toEqual(['/Users/me/repo/src/app.ts'])
      cleanup()
      renderMenus({ mobileFileActions: file })
      fireEvent.click(rows().find((row) => row.textContent === 'Copy relative path')!)
      expect(writes).toEqual(['/Users/me/repo/src/app.ts', 'src/app.ts'])
    })
  })
})

describe('commit actions', () => {
  const commit = { sha: 'abcdef1234567890', shortSha: 'abcdef1', subject: 'Fix the parser' }

  it('names a commit by its subject and short SHA on a phone, with Undo last only on the latest commit', () => {
    const onOpenCommitTab = mock((..._args: unknown[]) => {})
    const first = renderMenus({ mobileCommitActions: commit, isLatestCommit: true, onOpenCommitTab })
    const sheet = screen.getByRole('dialog', { name: 'Fix the parser' })
    expect(within(sheet).getByText('abcdef1')).toBeTruthy()
    expect(rows().map((row) => row.textContent)).toEqual([
      'Open in tab', 'Revert commit…', 'Copy short SHA', 'Copy full SHA', 'Copy commit message', 'Undo commit…',
    ])
    fireEvent.click(rows()[0]!)
    expect(onOpenCommitTab).toHaveBeenCalledWith('abcdef1234567890')
    first.unmount()
    renderMenus({ mobileCommitActions: commit, isLatestCommit: false })
    expect(rows().map((row) => row.textContent)).not.toContain('Undo commit…')
  })
})
