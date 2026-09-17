/**
 * Tests for MemorySettingsPage — memory viewer, editor, and conflict handling.
 */
import { describe, it, expect, afterEach, mock } from 'bun:test'
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react'

import { MemorySettingsPage } from '@/components/settings/pages/settings.memory'
import { ApiValidationError } from '@/api/client'

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

let mockFileData = {
  path: 'preferences.md',
  content: '# Preferences\nInitial text\n',
  etag: '"etag-123"',
  frontmatter: null,
}

mock.module('@/queries', () => ({
  useMemoryTreeQuery: () => ({
    data: mockTreeData,
    isLoading: false,
    refetch: mock(() => Promise.resolve()),
  }),
  useMemoryFileQuery: () => ({
    data: mockFileData,
    isLoading: false,
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
  })

  it('renders memory header and lists pages', () => {
    render(<MemorySettingsPage />)
    expect(screen.getByText('Memory')).toBeDefined()
    expect(screen.getAllByText('preferences.md').length).toBeGreaterThan(0)
    expect(screen.getByText('topics/db.md')).toBeDefined()
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
      expect(screen.getByText('Conflict Detected')).toBeDefined()
      expect(screen.getByText('Keep My Draft')).toBeDefined()
      expect(screen.getByText('Reload File')).toBeDefined()
    })
  })

  it('runs lint and displays findings banner', async () => {
    render(<MemorySettingsPage />)
    const lintBtn = screen.getByText('Run Lint')
    fireEvent.click(lintBtn)

    await waitFor(() => {
      expect(screen.getByText('1 issue(s) found:')).toBeDefined()
      expect(screen.getByText(/Target \[\[missing\]\] not found/)).toBeDefined()
    })
  })

  it('saves with Cmd+S keyboard shortcut when dirty', async () => {
    render(<MemorySettingsPage />)
    const textarea = screen.getByPlaceholderText('Markdown content...') as HTMLTextAreaElement
    fireEvent.change(textarea, { target: { value: '# Preferences\nKeyboard save content\n' } })

    fireEvent.keyDown(window, { key: 's', metaKey: true })

    await waitFor(() => {
      expect(mockSaveMutate).toHaveBeenCalled()
    })
    const callArgs = mockSaveMutate.mock.calls[0][0] as any
    expect(callArgs.path).toBe('preferences.md')
    expect(callArgs.content).toContain('Keyboard save content')
  })

  it('opens delete confirmation dialog and deletes file', async () => {
    render(<MemorySettingsPage />)
    const deleteBtn = screen.getByText('Delete')
    fireEvent.click(deleteBtn)

    await waitFor(() => {
      expect(screen.getByText('Delete Memory Page')).toBeDefined()
    })

    // Inside dialog, there's another Delete button in the footer
    const confirmBtn = screen.getAllByRole('button', { name: 'Delete' }).pop()!
    fireEvent.click(confirmBtn)

    await waitFor(() => {
      expect(mockDeleteMutate).toHaveBeenCalled()
    })
    const callArgs = mockDeleteMutate.mock.calls[0][0] as any
    expect(callArgs.path).toBe('preferences.md')
  })

  it('opens new memory page dialog and creates page', async () => {
    render(<MemorySettingsPage />)
    const newPageBtn = screen.getByLabelText('New Page')
    fireEvent.click(newPageBtn)

    await waitFor(() => {
      expect(screen.getByText('New Memory Page')).toBeDefined()
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
