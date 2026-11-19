/**
 * Tests for MemorySettingsPage — memory viewer, editor, and conflict handling.
 */
import { describe, it, expect, afterEach, mock } from 'bun:test'
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react'

import { MemorySettingsPage } from '@/components/settings/pages/settings.memory'
import { PAGE_BODY, PAGE_BODY_WIDE } from '@/components/settings/tokens'
import { ApiValidationError } from '@/api/client'
import { getPlatform } from '@/hooks/use-platform'

mock.module('lucide-react', () => new Proxy({}, { get: () => () => null }))

const savedPage = async () => ({
  path: 'preferences.md',
  content: 'Updated preferences',
  etag: '"new-etag"',
  frontmatter: null,
})
const mockSaveMutate = mock(savedPage)

const mockDeleteMutate = mock(async () => ({}))

let mockTreeData = {
  pages: [
    { path: 'preferences.md', title: 'Preferences', type: 'general' },
    { path: 'topics/db.md', title: 'Database', type: 'topic' },
  ],
}

type FileData = { path: string; content: string; etag: string; frontmatter: null }
let mockFileData: FileData | undefined = {
  path: 'preferences.md',
  content: '# Preferences\nInitial text\n',
  etag: '"etag-123"',
  frontmatter: null,
}
let mockFileError: Error | null = null
/** Per-path pages, for tests that open more than one; otherwise every path reads `mockFileData`. */
let mockFiles: Record<string, FileData> | null = null

mock.module('@/queries', () => ({
  useMemoryTreeQuery: () => ({
    data: mockTreeData,
    isLoading: false,
    refetch: mock(() => Promise.resolve()),
  }),
  useMemoryFileQuery: (path: string | null) => ({
    data: mockFiles ? (path ? mockFiles[path] : undefined) : mockFileData,
    isLoading: false,
    isError: mockFileError !== null,
    error: mockFileError,
    refetch: mock(() => Promise.resolve({ data: mockFileData })),
  }),
  useSaveMemoryFileMutation: () => ({
    mutateAsync: mockSaveMutate,
    isPending: false,
  }),
  useDeleteMemoryFileMutation: () => ({
    mutateAsync: mockDeleteMutate,
    isPending: false,
  }),
}))

mock.module('@/api/client', () => ({
  ApiValidationError,
  lintMemory: mock(async () => ({
    findings: [{ code: 'BROKEN_LINK', path: 'topics/db.md', message: 'Target [[missing]] not found' }],
  })),
}))

describe('MemorySettingsPage', () => {
  /** `DialogFooter` as it is: none of the `flex-row` / `justify-end` / `mt-4` the page used to pass in. */
  function expectFooterAsIs(footer: Element | null) {
    expect(footer).not.toBeNull()
    const tokens = (footer?.className ?? '').split(/\s+/)
    for (const own of ['flex-row', 'justify-end', 'mt-4']) expect(tokens).not.toContain(own)
    // Its own spacing from the body (16px), not the page's.
    expect(tokens).toContain('mt-5')
  }

  afterEach(() => {
    cleanup()
    mockSaveMutate.mockClear()
    // A test's rejection must not stay in place for the tests after it.
    mockSaveMutate.mockImplementation(savedPage)
    mockDeleteMutate.mockClear()
    mockFileError = null
    mockFiles = null
    mockFileData = {
      path: 'preferences.md',
      content: '# Preferences\nInitial text\n',
      etag: '"etag-123"',
      frontmatter: null,
    }
  })

  it('renders memory header and lists pages', () => {
    render(<MemorySettingsPage />)
    expect(screen.getByText('Memory')).toBeDefined()
    expect(screen.getAllByText('preferences.md').length).toBeGreaterThan(0)
    expect(screen.getByText('topics/db.md')).toBeDefined()
    // The list header counts the pages
    expect(screen.getByText('Pages', { selector: 'span' }).textContent).toBe('Pages · 2')
  })

  it('starts at the same left edge as the other pages, and only extends to the right', () => {
    render(<MemorySettingsPage />)
    // The header sits in the shared reading column; the list and editor in a
    // body that begins at that column's left edge and takes the rest.
    const header = screen.getByRole('heading', { level: 1, name: 'Memory' }).closest('header')?.parentElement as HTMLElement
    expect(header.className).toContain(PAGE_BODY)
    const pane = screen.getByText('Pages', { selector: 'span' }).closest('.rounded-sm') as HTMLElement
    expect((pane.parentElement as HTMLElement).className).toContain(PAGE_BODY_WIDE)
    // The wide body measures the edge from the same column width.
    expect(PAGE_BODY).toContain('max-w-3xl')
    expect(PAGE_BODY_WIDE).toContain('48rem')
    // The pane takes its inset from the body, not a margin of its own.
    expect(pane.className).not.toMatch(/(^|\s)(md:)?mx-/)
  })

  it('loads file content into textarea and saves with If-Match', async () => {
    render(<MemorySettingsPage />)
    const textarea = screen.getByPlaceholderText('Markdown content…') as HTMLTextAreaElement
    expect(textarea.value).toContain('Initial text')

    fireEvent.change(textarea, { target: { value: '# Preferences\nNew modified content\n' } })
    expect(textarea.value).toContain('New modified content')

    const saveBtn = screen.getByText('Save')
    fireEvent.click(saveBtn)

    expect(mockSaveMutate).toHaveBeenCalled()
    const callArgs = mockSaveMutate.mock.calls[0][0] as any
    expect(callArgs.path).toBe('preferences.md')
    expect(callArgs.ifMatch).toBe('"etag-123"')
    expect(callArgs.content).toContain('New modified content')
  })

  it('opens conflict dialog on HTTP 412 Precondition Failed', async () => {
    mockSaveMutate.mockImplementation(async () => {
      throw new ApiValidationError(412, 'ETag mismatch')
    })

    render(<MemorySettingsPage />)
    const textarea = screen.getByPlaceholderText('Markdown content…') as HTMLTextAreaElement
    fireEvent.change(textarea, { target: { value: 'Conflicting edit' } })

    const saveBtn = screen.getByText('Save')
    fireEvent.click(saveBtn)

    await waitFor(() => {
      expect(screen.getByText('This page changed elsewhere')).toBeDefined()
      expect(screen.getByText('Keep my draft')).toBeDefined()
      expect(screen.getByText('Reload and discard edits')).toBeDefined()
    })
  })

  it('never saves when the page failed to load', () => {
    mockFileData = undefined
    mockFileError = new Error('read failed')
    render(<MemorySettingsPage />)

    expect(screen.queryByPlaceholderText('Markdown content…')).toBeNull()
    expect(screen.getByText("Couldn't load preferences.md")).toBeDefined()
    expect(screen.getByRole('button', { name: 'Retry' })).toBeDefined()
    // Nothing to save: the save bar shows only for edits to a loaded page.
    expect(screen.queryByRole('button', { name: /^Save/ })).toBeNull()
    expect(mockSaveMutate).not.toHaveBeenCalled()
  })

  it('saves from the settings save bar, which offers Discard too', async () => {
    render(<MemorySettingsPage />)
    expect(screen.queryByRole('button', { name: /^Save/ })).toBeNull()
    const textarea = screen.getByPlaceholderText('Markdown content…') as HTMLTextAreaElement
    fireEvent.change(textarea, { target: { value: 'Edited' } })

    expect(await screen.findByText('Unsaved changes')).toBeDefined()
    expect(screen.getByRole('button', { name: /Discard/ })).toBeDefined()
  })

  it('asks before opening another page over unsaved edits, and keeps them on Cancel', async () => {
    mockFiles = {
      'preferences.md': { path: 'preferences.md', content: 'Prefs', etag: '"a"', frontmatter: null },
      'topics/db.md': { path: 'topics/db.md', content: 'Database notes', etag: '"b"', frontmatter: null },
    }
    render(<MemorySettingsPage />)
    const textarea = () => screen.getByPlaceholderText('Markdown content…') as HTMLTextAreaElement
    await waitFor(() => expect(textarea().value).toBe('Prefs'))
    fireEvent.change(textarea(), { target: { value: 'Prefs, edited' } })

    fireEvent.click(screen.getByRole('button', { name: 'topics/db.md' }))

    expect(await screen.findByText('Discard changes?')).toBeDefined()
    expect(textarea().value).toBe('Prefs, edited')
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(textarea().value).toBe('Prefs, edited')

    // Discarding opens the other page.
    fireEvent.click(screen.getByRole('button', { name: 'topics/db.md' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Discard changes' }))
    await waitFor(() => expect(textarea().value).toBe('Database notes'))
  })

  it('opens another page at once when nothing is edited', async () => {
    mockFiles = {
      'preferences.md': { path: 'preferences.md', content: 'Prefs', etag: '"a"', frontmatter: null },
      'topics/db.md': { path: 'topics/db.md', content: 'Database notes', etag: '"b"', frontmatter: null },
    }
    render(<MemorySettingsPage />)
    fireEvent.click(screen.getByRole('button', { name: 'topics/db.md' }))
    expect(screen.queryByText('Discard changes?')).toBeNull()
    await waitFor(() => expect((screen.getByPlaceholderText('Markdown content…') as HTMLTextAreaElement).value).toBe('Database notes'))
  })

  it('keeps typed edits when the page is fetched again', async () => {
    const { rerender } = render(<MemorySettingsPage />)
    const textarea = screen.getByPlaceholderText('Markdown content…') as HTMLTextAreaElement
    fireEvent.change(textarea, { target: { value: 'Mine' } })

    // The agent saved the page: a new snapshot arrives.
    mockFileData = { path: 'preferences.md', content: 'Theirs', etag: '"etag-456"', frontmatter: null }
    rerender(<MemorySettingsPage />)

    expect((screen.getByPlaceholderText('Markdown content…') as HTMLTextAreaElement).value).toBe('Mine')
  })

  it('runs lint and displays findings banner', async () => {
    render(<MemorySettingsPage />)
    const lintBtn = screen.getByText('Check links')
    fireEvent.click(lintBtn)

    await waitFor(() => {
      expect(screen.getByText('1 problem found')).toBeDefined()
      expect(screen.getByText(/Target \[\[missing\]\] not found/)).toBeDefined()
    })
  })

  it('saves with Cmd+S keyboard shortcut when dirty', async () => {
    // Pages live inside the Settings modal; their ⌘S is scoped to it.
    render(<div data-settings-modal=""><MemorySettingsPage /></div>)
    const textarea = screen.getByPlaceholderText('Markdown content…') as HTMLTextAreaElement
    fireEvent.change(textarea, { target: { value: '# Preferences\nKeyboard save content\n' } })

    const mac = getPlatform().os === 'macos'
    fireEvent.keyDown(textarea, { key: 's', metaKey: mac, ctrlKey: !mac })

    await waitFor(() => {
      expect(mockSaveMutate).toHaveBeenCalled()
    })
    const callArgs = mockSaveMutate.mock.calls[0][0] as any
    expect(callArgs.path).toBe('preferences.md')
    expect(callArgs.content).toContain('Keyboard save content')
  })

  it('opens delete confirmation dialog and deletes file', async () => {
    render(<MemorySettingsPage />)
    // Delete lives in the page's "More actions" menu, not as a visible button
    expect(screen.queryByText('Delete…')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'More actions for preferences.md' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Delete page…' }))

    await waitFor(() => {
      expect(screen.getByText('Delete this memory page?')).toBeDefined()
    })

    // A confirm: no ×, Cancel dismisses, and the footer is the dialog's own.
    expect(screen.queryByRole('button', { name: 'Close' })).toBeNull()
    expectFooterAsIs(screen.getByRole('button', { name: 'Cancel' }).closest('[data-slot="dialog-footer"]'))

    const confirmBtn = screen.getByRole('button', { name: 'Delete page' })
    fireEvent.click(confirmBtn)

    await waitFor(() => {
      expect(mockDeleteMutate).toHaveBeenCalled()
    })
    const callArgs = mockDeleteMutate.mock.calls[0][0] as any
    expect(callArgs.path).toBe('preferences.md')
  })

  it('deletes once when Delete page is pressed twice', async () => {
    render(<MemorySettingsPage />)
    fireEvent.click(screen.getByRole('button', { name: 'More actions for preferences.md' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Delete page…' }))
    const confirm = await screen.findByRole('button', { name: 'Delete page' })

    fireEvent.click(confirm)
    fireEvent.click(confirm)

    await waitFor(() => expect(screen.queryByText('Delete this memory page?')).toBeNull())
    expect(mockDeleteMutate).toHaveBeenCalledTimes(1)
  })

  it('opens new memory page dialog and creates page', async () => {
    render(<MemorySettingsPage />)
    // A visible text button now (its name is still "New page")
    const newPageBtn = screen.getByRole('button', { name: 'New page' })
    expect(newPageBtn.textContent).toBe('New page')
    fireEvent.click(newPageBtn)

    await waitFor(() => {
      expect(screen.getByText('New memory page')).toBeDefined()
    })

    const input = screen.getByPlaceholderText('topics/new-page.md') as HTMLInputElement
    fireEvent.change(input, { target: { value: 'topics/notes.md' } })

    const createBtn = screen.getByRole('button', { name: 'Create' })
    expectFooterAsIs(createBtn.closest('[data-slot="dialog-footer"]'))
    fireEvent.click(createBtn)

    await waitFor(() => {
      expect(mockSaveMutate).toHaveBeenCalled()
    })
    const callArgs = mockSaveMutate.mock.calls[0][0] as any
    expect(callArgs.path).toBe('topics/notes.md')
  })

  it('creates the page on Enter, and once when Create is pressed twice', async () => {
    render(<MemorySettingsPage />)
    fireEvent.click(screen.getByRole('button', { name: 'New page' }))
    const input = await screen.findByPlaceholderText('topics/new-page.md')
    fireEvent.change(input, { target: { value: 'topics/notes' } })

    // Enter in the field submits its form, as the Create button does.
    const form = input.closest('form')
    expect(form).not.toBeNull()
    fireEvent.submit(form!)
    fireEvent.click(screen.getByRole('button', { name: 'Create' }))

    await waitFor(() => expect(screen.queryByText('New memory page')).toBeNull())
    expect(mockSaveMutate).toHaveBeenCalledTimes(1)
    expect((mockSaveMutate.mock.calls[0][0] as any).path).toBe('topics/notes.md')
  })

  it('ties the path error to its field', async () => {
    render(<MemorySettingsPage />)
    fireEvent.click(screen.getByRole('button', { name: 'New page' }))
    const input = await screen.findByPlaceholderText('topics/new-page.md')
    fireEvent.change(input, { target: { value: 'topics/db' } })
    fireEvent.click(screen.getByRole('button', { name: 'Create' }))

    const error = await screen.findByRole('alert')
    expect(input.getAttribute('aria-describedby')).toBe(error.id)
  })

  it('refuses to create a page over one that exists', async () => {
    render(<MemorySettingsPage />)
    fireEvent.click(screen.getByRole('button', { name: 'New page' }))
    fireEvent.change(await screen.findByPlaceholderText('topics/new-page.md'), { target: { value: 'topics/db' } })
    fireEvent.click(screen.getByRole('button', { name: 'Create' }))

    expect((await screen.findByRole('alert')).textContent).toContain('topics/db.md already exists')
    expect(mockSaveMutate).not.toHaveBeenCalled()
  })
})
