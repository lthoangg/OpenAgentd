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
  scope: 'global',
  frontmatter: null,
}))

const mockDeleteMutate = mock(async () => ({}))

let mockTreeData = {
  pages: [
    { path: 'preferences.md', title: 'Preferences', type: 'general', scope: 'global' },
    { path: 'topics/db.md', title: 'Database', type: 'topic', scope: 'global' },
  ],
}

let mockFileData = {
  path: 'preferences.md',
  content: '# Preferences\nInitial text\n',
  etag: '"etag-123"',
  scope: 'global',
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

mock.module('@/stores/useAgentStore', () => ({
  useAgentStore: (fn: any) => fn({ _workspace: '/test/workspace' }),
}))

mock.module('@/queries/useChatWorkspace', () => ({
  isChatWorkspacePath: () => false,
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

  it('renders memory tabs and lists pages', () => {
    render(<MemorySettingsPage />)
    expect(screen.getByText('Memory')).toBeDefined()
    expect(screen.getByText('Global Memory')).toBeDefined()
    expect(screen.getByText('Workspace Memory')).toBeDefined()
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
})
