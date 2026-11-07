/**
 * On a phone a memory page opens full screen: Save in the bar, a formatting
 * bar above the keyboard (mockup J10 10.5).
 */
import { describe, it, expect, afterEach, mock } from 'bun:test'
import { render, screen, cleanup, fireEvent, waitFor, within } from '@testing-library/react'

import { ApiValidationError } from '@/api/client'
import { MemorySettingsPage } from '@/components/settings/pages/settings.memory'

mock.module('lucide-react', () => new Proxy({}, { get: () => () => null }))
mock.module('@/hooks/use-is-phone', () => ({ useIsPhone: () => true }))

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


describe('MemorySettingsPage on a phone', () => {
  afterEach(cleanup)

  it('opens a page full screen with Save in the bar and a formatting bar', async () => {
    render(<MemorySettingsPage />)
    fireEvent.click(screen.getAllByText('topics/db.md')[0])
    const editor = document.querySelector<HTMLElement>('[data-memory-editor="phone"]')!
    expect(editor).not.toBeNull()
    const area = editor.querySelector('textarea')!
    await waitFor(() => expect(area.value).toContain('Initial text'))
    fireEvent.change(area, { target: { value: 'hello' } })
    area.setSelectionRange(0, 5)
    fireEvent.click(within(editor).getByRole('button', { name: 'Bold' }))
    expect(area.value).toBe('**hello**')
    fireEvent.click(within(editor).getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(mockSaveMutate).toHaveBeenCalled())
  })
})
