import { afterEach, describe, expect, it, mock } from 'bun:test'
import type { ReactNode } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'

mock.module('lucide-react', () => new Proxy({}, { get: () => () => null }))

import { ToolCall } from '@/components/ToolCall'
import { parseImageRead } from '@/components/ToolCall/imageRead'
import { FileRefContext, type FileRefOpener } from '@/components/FileRefLink'
import { queryKeys } from '@/queries/keys'
import { workspaceRelativePath } from '@/utils/file-refs'
import type { WorkspaceFileInfo } from '@/api/types'

afterEach(cleanup)

const WORKSPACE = '/repo'

function file(path: string): WorkspaceFileInfo {
  return { path, name: path.split('/').pop() ?? path, size: 10, mtime: 0, mime: 'image/png' }
}

function opener(): FileRefOpener & { open: ReturnType<typeof mock> } {
  return {
    workspace: WORKSPACE,
    canOpen: (ref) => workspaceRelativePath(ref.path, WORKSPACE) !== null,
    open: mock((..._args: unknown[]) => {}),
  }
}

function renderWith(ui: ReactNode, files: string[], fileOpener: FileRefOpener | null = opener()) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })
  client.setQueryData(queryKeys.coding.files(WORKSPACE), { workspace: WORKSPACE, files: files.map(file), truncated: false })
  render(
    <QueryClientProvider client={client}>
      <FileRefContext.Provider value={fileOpener}>{ui}</FileRefContext.Provider>
    </QueryClientProvider>,
  )
  return fileOpener
}

const readArgs = (path: string) => JSON.stringify({ path })

describe('parseImageRead', () => {
  it('reads the path from a plain and a resized image result', () => {
    expect(parseImageRead('[Image: docs/shot.png]')).toEqual({ path: 'docs/shot.png' })
    expect(parseImageRead('[Image: docs/my shot (1).png (resized 2400×1600 → 2000×1333)]')).toEqual({ path: 'docs/my shot (1).png' })
  })

  it('ignores text, error, and missing results', () => {
    expect(parseImageRead('[1-3/3]\nhello')).toBeNull()
    expect(parseImageRead('Error: File not found: docs/shot.png')).toBeNull()
    expect(parseImageRead('[Document: a.pdf]\ntext')).toBeNull()
    expect(parseImageRead(undefined)).toBeNull()
  })
})

describe('image read View chip', () => {
  it('opens an image that exists in the workspace in the panel', () => {
    const files = renderWith(
      <ToolCall name="read" args={readArgs('docs/shot.png')} done result="[Image: docs/shot.png (resized 2400×1600 → 2000×1333)]" />,
      ['docs/shot.png'],
    ) as ReturnType<typeof opener>

    fireEvent.click(screen.getByRole('button', { name: 'View image' }))
    expect(files.open).toHaveBeenCalledWith({ path: 'docs/shot.png' })
  })

  it('offers nothing for an image that is no longer in the workspace', () => {
    renderWith(<ToolCall name="read" args={readArgs('docs/gone.png')} done result="[Image: docs/gone.png]" />, ['docs/shot.png'])
    expect(screen.queryByRole('button', { name: 'View image' })).toBeNull()
  })

  it('offers nothing for an image outside the workspace', () => {
    renderWith(<ToolCall name="read" args={readArgs('/elsewhere/logo.png')} done result="[Image: /elsewhere/logo.png]" />, ['logo.png'])
    expect(screen.queryByRole('button', { name: 'View image' })).toBeNull()
  })

  it('offers nothing for a text read, a running read, or a surface without a workspace', () => {
    renderWith(<ToolCall name="read" args={readArgs('docs/a.md')} done result={'[1-1/1]\nhi'} />, ['docs/a.md'])
    expect(screen.queryByRole('button', { name: 'View image' })).toBeNull()
    cleanup()

    renderWith(<ToolCall name="read" args={readArgs('docs/shot.png')} />, ['docs/shot.png'])
    expect(screen.queryByRole('button', { name: 'View image' })).toBeNull()
    cleanup()

    renderWith(<ToolCall name="read" args={readArgs('docs/shot.png')} done result="[Image: docs/shot.png]" />, ['docs/shot.png'], null)
    expect(screen.queryByRole('button', { name: 'View image' })).toBeNull()
  })
})
