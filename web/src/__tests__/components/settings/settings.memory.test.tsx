/**
 * Tests for MemorySettingsPage — memory viewer, editor, and conflict handling.
 */
import { describe, it, expect, afterEach, mock } from 'bun:test'
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react'

import { MemorySettingsPage } from '@/components/settings/pages/settings.memory'
import { ApiValidationError } from '@/api/client'
import { getPlatform } from '@/hooks/use-platform'

mock.module('lucide-react', () => new Proxy({}, { get: () => () => null }))

const mockSaveMutate = mock(async () => ({
  path: 'preferences.md',
  content: 'Updated preferences',
  etag: '"new-etag"',
  frontmatter: null,
}))

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

mock.module('@/queries', () => ({
  useMemoryTreeQuery: () => ({
    data: mockTreeData,
    isLoading: false,
    refetch: mock(() => Promise.resolve()),
  }),
  useMemoryFileQuery: () => ({
    data: mockFileData,
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
  afterEach(() => {
    cleanup()
    mockSaveMutate.mockClear()
    mockFileError = null
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

  it('loads file content into textarea and saves with If-Match', async () => {
    render(<MemorySettingsPage />)
    const textarea = screen.getByPlaceholderText('Markdown content...') as HTMLTextAreaElement
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
    const textarea = screen.getByPlaceholderText('Markdown content...') as HTMLTextAreaElement
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

    expect(screen.queryByPlaceholderText('Markdown content...')).toBeNull()
    expect(screen.getByText("Couldn't load preferences.md")).toBeDefined()
    expect(screen.getByRole('button', { name: 'Retry' })).toBeDefined()
    const saveBtn = screen.getByRole('button', { name: /Save/ }) as HTMLButtonElement
    expect(saveBtn.disabled).toBe(true)
    fireEvent.click(saveBtn)
    expect(mockSaveMutate).not.toHaveBeenCalled()
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
    const textarea = screen.getByPlaceholderText('Markdown content...') as HTMLTextAreaElement
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

    const confirmBtn = screen.getByRole('button', { name: 'Delete page' })
    fireEvent.click(confirmBtn)

    await waitFor(() => {
      expect(mockDeleteMutate).toHaveBeenCalled()
    })
    const callArgs = mockDeleteMutate.mock.calls[0][0] as any
    expect(callArgs.path).toBe('preferences.md')
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
    fireEvent.click(createBtn)

    await waitFor(() => {
      expect(mockSaveMutate).toHaveBeenCalled()
    })
    const callArgs = mockSaveMutate.mock.calls[0][0] as any
    expect(callArgs.path).toBe('topics/notes.md')
  })
})
