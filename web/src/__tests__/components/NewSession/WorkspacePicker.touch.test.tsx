import { afterEach, describe, expect, it } from 'bun:test'
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { WorkspacePicker } from '@/components/NewSession/WorkspacePicker'

const original = window.matchMedia

afterEach(() => {
  cleanup()
  window.matchMedia = original
})

function stubPointer(fine: boolean) {
  window.matchMedia = ((query: string) => ({
    matches: query === '(pointer: fine)' ? fine : false,
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
  })) as unknown as typeof window.matchMedia
}

async function openPicker() {
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
  return screen.findByRole('combobox', { name: 'Filter folders' })
}

describe('WorkspacePicker autofocus', () => {
  it('focuses the filter field with a mouse', async () => {
    stubPointer(true)
    const filter = await openPicker()
    expect(document.activeElement).toBe(filter)
  })

  it('leaves the filter field unfocused on touch so the keyboard stays down', async () => {
    stubPointer(false)
    const filter = await openPicker()
    expect(document.activeElement).not.toBe(filter)
  })
})
