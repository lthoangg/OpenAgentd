/**
 * Desktop's "/" and "@" menus (mockups 3.4 / 3.5): a file reads name first,
 * its folder after (the folder gives way, never the name); a command with an
 * app shortcut shows it; and the menu ends with the keys that drive it.
 */
import { afterEach, describe, expect, it, mock } from 'bun:test'
import { cleanup, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

mock.module('lucide-react', () => new Proxy({}, { get: () => () => null }))
mock.module('@/hooks/use-mobile', () => ({ useIsMobile: () => false }))
mock.module('@/hooks/use-is-phone', () => ({ useIsPhone: () => false }))
mock.module('@/hooks/use-platform', () => ({
  usePlatform: () => ({ isTauri: false, os: 'macos', isMacOverlay: false }),
  getPlatform: () => ({ isTauri: false, os: 'macos', isMacOverlay: false }),
}))

import { InputComposer } from '@/components/InputComposer'
import type { FileRef, SlashCommand } from '@/components/InputComposer'

afterEach(cleanup)

const FILES: FileRef[] = [
  { path: 'web/src/components/composer/Composer.tsx', name: 'Composer.tsx', type: 'file' },
  { path: 'web/src/components/composer', name: 'composer', type: 'directory' },
]
const COMMANDS: SlashCommand[] = [
  { id: 'new', label: 'New session', description: 'Start a fresh agent conversation', shortcut: 'newSession' },
  { id: 'compact', label: 'Compact', description: 'Summarize and compact this session' },
]

async function open(text: string) {
  const user = userEvent.setup()
  render(<InputComposer onSubmit={() => {}} fileRefs={FILES} slashCommands={COMMANDS} />)
  await user.type(screen.getByLabelText('Message input'), text)
}

describe('InputComposer menus on desktop', () => {
  it('names a file before its folder, and only the folder gives way', async () => {
    await open('@Composer')
    const option = screen.getAllByRole('option').find((o) => o.querySelector('[data-mention-name]')?.textContent === 'Composer.tsx')!
    const name = option.querySelector<HTMLElement>('[data-mention-name]')!
    const folder = option.querySelector<HTMLElement>('[data-mention-folder]')!

    expect(name.textContent).toBe('Composer.tsx')
    expect(folder.textContent).toBe('web/src/components/composer/')
    expect(name.compareDocumentPosition(folder) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(name.className).toContain('shrink-0')
    expect(folder.className).toContain('truncate')
    expect(option.getAttribute('aria-label')).toBe('web/src/components/composer/Composer.tsx')
  })

  it('marks a folder with a trailing slash on its name', async () => {
    await open('@composer')
    const folderRow = screen.getAllByRole('option').find((o) => o.querySelector('[data-mention-name]')?.textContent === 'composer/')
    expect(folderRow).toBeTruthy()
  })

  it("shows a command's app shortcut beside it, and none for one without", async () => {
    await open('/')
    const [newRow, compactRow] = screen.getAllByRole('option')

    expect(within(newRow).getByText('⌘N').getAttribute('aria-hidden')).toBe('true')
    expect(compactRow.querySelector('kbd')).toBeNull()
  })

  it('ends the slash menu with the keys that drive it', async () => {
    await open('/')
    const keys = screen.getByRole('listbox', { name: 'Slash commands' }).querySelector<HTMLElement>('[data-menu-keys]')!

    expect(keys.getAttribute('aria-hidden')).toBe('true')
    expect(keys.textContent).toBe('↑↓ navigate↵ runEsc close')
  })

  it('says a file pick inserts it', async () => {
    await open('@')
    const keys = screen.getByRole('listbox', { name: 'Reference workspace file' }).querySelector<HTMLElement>('[data-menu-keys]')!

    expect(keys.textContent).toBe('↑↓ navigate↵ insertEsc close')
  })
})
