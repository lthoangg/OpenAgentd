import { afterEach, describe, expect, it, mock } from 'bun:test'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

import { FileRefContext, LinkifiedText, MarkdownLink, type FileRefOpener } from '@/components/FileRefLink'
import { ToolResult } from '@/components/ToolResult'
import { MarkdownBlock } from '@/utils/markdown'
import type { FileRef } from '@/utils/file-refs'

afterEach(cleanup)

function opener(): FileRefOpener & { open: ReturnType<typeof mock> } {
  return {
    canOpen: (ref: FileRef) => !ref.path.startsWith('/elsewhere/'),
    open: mock((..._args: unknown[]) => {}),
  }
}

describe('LinkifiedText', () => {
  it('turns locations in output into buttons that open them', () => {
    const files = opener()
    render(
      <FileRefContext.Provider value={files}>
        <pre><LinkifiedText text={'src/a.ts:12:5: error TS2322\n    at x (/elsewhere/b.ts:3:1)'} /></pre>
      </FileRefContext.Provider>,
    )

    fireEvent.click(screen.getByRole('button', { name: 'src/a.ts:12:5' }))
    expect(files.open).toHaveBeenCalledWith({ path: 'src/a.ts', line: 12, column: 5 })
    // Outside the workspace: nothing to open, so it stays text.
    expect(screen.queryByRole('button', { name: /elsewhere/ })).toBeNull()
    expect(screen.getByText(/error TS2322/)).toBeTruthy()
  })

  it('links a line that is wholly a file name', () => {
    render(
      <FileRefContext.Provider value={opener()}>
        <LinkifiedText text="package.json" />
      </FileRefContext.Provider>,
    )
    expect(screen.getByRole('button', { name: 'package.json' })).toBeTruthy()
  })

  it('stays plain text where nothing can open files', () => {
    render(<LinkifiedText text="src/a.ts:12" />)
    expect(screen.queryByRole('button')).toBeNull()
    expect(screen.getByText('src/a.ts:12')).toBeTruthy()
  })
})

describe('file references in Markdown', () => {
  it('opens a code span that names a file, at its line', () => {
    const files = opener()
    render(
      <FileRefContext.Provider value={files}>
        <MarkdownBlock content="The bug is in `src/app.ts:42`, not in `config.enabled`." />
      </FileRefContext.Provider>,
    )

    fireEvent.click(screen.getByRole('button', { name: 'src/app.ts:42' }))
    expect(files.open).toHaveBeenCalledWith({ path: 'src/app.ts', line: 42 })
    expect(screen.queryByRole('button', { name: 'config.enabled' })).toBeNull()
  })

  it('opens a code span that names a line range, and says which lines', () => {
    const files = opener()
    render(
      <FileRefContext.Provider value={files}>
        <MarkdownBlock content="See `src/app.ts:42-58`." />
      </FileRefContext.Provider>,
    )

    const range = screen.getByRole('button', { name: 'src/app.ts:42-58' })
    expect(range.getAttribute('title')).toBe('Open src/app.ts at lines 42-58')
    fireEvent.click(range)
    expect(files.open).toHaveBeenCalledWith({ path: 'src/app.ts', line: 42, endLine: 58 })
  })

  it('opens a relative link in the workspace instead of a new tab', () => {
    const files = opener()
    render(
      <FileRefContext.Provider value={files}>
        <MarkdownBlock content="See [the guide](docs/guide.md#L3) and [the site](https://x.dev)." />
      </FileRefContext.Provider>,
    )

    const guide = screen.getByRole('link', { name: 'the guide' })
    expect(guide.getAttribute('target')).toBeNull()
    fireEvent.click(guide)
    expect(files.open).toHaveBeenCalledWith({ path: 'docs/guide.md', line: 3 })
    expect(screen.getByRole('link', { name: 'the site' }).getAttribute('target')).toBe('_blank')
  })

  it('keeps a code span inside a link from nesting a second control', () => {
    const files = opener()
    render(
      <FileRefContext.Provider value={files}>
        <MarkdownBlock content="Edit [`src/a.ts`](src/a.ts) and [`b.ts`](https://x.dev/b.ts)." />
      </FileRefContext.Provider>,
    )

    expect(screen.queryByRole('button')).toBeNull()
    fireEvent.click(screen.getByRole('link', { name: 'src/a.ts' }))
    expect(files.open).toHaveBeenCalledTimes(1)
  })

  it.each(['DESIGN.md', 'docs/guide.mdx', '.agents/plans/x/mockup.html', 'site/index.htm'])(
    'renders a code span naming the document %s as a plain link',
    (path) => {
      const files = opener()
      const { container } = render(
        <FileRefContext.Provider value={files}>
          <MarkdownBlock content={`Read \`${path}\` first.`} />
        </FileRefContext.Provider>,
      )

      expect(container.querySelector('code')).toBeNull()
      expect(screen.queryByRole('button')).toBeNull()
      fireEvent.click(screen.getByRole('link', { name: path }))
      expect(files.open).toHaveBeenCalledWith({ path })
    },
  )

  it('drops the code box from a document name inside a link', () => {
    const files = opener()
    const { container } = render(
      <FileRefContext.Provider value={files}>
        <MarkdownBlock content="Read [`web/AGENTS.md`](web/AGENTS.md)." />
      </FileRefContext.Provider>,
    )

    expect(container.querySelector('code')).toBeNull()
    fireEvent.click(screen.getByRole('link', { name: 'web/AGENTS.md' }))
    expect(files.open).toHaveBeenCalledWith({ path: 'web/AGENTS.md' })
  })

  it('shows a document it cannot open as plain text', () => {
    const { container } = render(<MarkdownBlock content="Read `DESIGN.md` first." />)

    expect(container.querySelector('code')).toBeNull()
    expect(screen.queryByRole('link')).toBeNull()
    expect(container.textContent).toContain('Read DESIGN.md first.')
  })

  it('keeps code spans for source files, document lines, and identifiers', () => {
    const files = opener()
    const { container } = render(
      <FileRefContext.Provider value={files}>
        <MarkdownBlock content="See `src/app.ts:42`, `README.md:12`, and `config.enabled`." />
      </FileRefContext.Provider>,
    )

    const codes = [...container.querySelectorAll('code')].map((c) => c.textContent)
    expect(codes).toEqual(['src/app.ts:42', 'README.md:12', 'config.enabled'])
    fireEvent.click(screen.getByRole('button', { name: 'README.md:12' }))
    expect(files.open).toHaveBeenCalledWith({ path: 'README.md', line: 12 })
  })
})

describe('local web links in Markdown', () => {
  it.each([
    'http://localhost:5173/page?q=1#section',
    'https://localhost:5173/page',
    'http://127.0.0.1:3000',
    'http://127.0.0.2:3000',
    'http://[::1]:3000',
  ])('opens %s in Preview instead of a browser tab', (url) => {
    const files = { ...opener(), openPreview: mock(() => {}) }
    render(
      <FileRefContext.Provider value={files}>
        <MarkdownBlock content={`See [the app](${url}).`} />
      </FileRefContext.Provider>,
    )

    const link = screen.getByRole('link', { name: 'the app' })
    expect(fireEvent.click(link)).toBe(false)
    expect(link.getAttribute('target')).toBeNull()
    expect(files.openPreview).toHaveBeenCalledWith({ kind: 'url', url })
    expect(files.open).not.toHaveBeenCalled()
  })

  it.each([
    'http://localhost:5173/page?q=1#section',
    '<http://localhost:5173/page?q=1#section>',
  ])('leaves unlinked URL text unchanged: %s', (text) => {
    const files = { ...opener(), openPreview: mock(() => {}) }
    render(
      <FileRefContext.Provider value={files}>
        <MarkdownBlock content={`See ${text}`} />
      </FileRefContext.Provider>,
    )

    // The renderer does not autolink these forms; linkification is unchanged.
    expect(screen.queryByRole('link')).toBeNull()
    expect(screen.getByText(`See ${text}`)).toBeTruthy()
    expect(files.openPreview).not.toHaveBeenCalled()
  })

  it('supports keyboard activation and the app menu Open link action', async () => {
    const url = 'http://localhost:5173/page'
    const files = { ...opener(), openPreview: mock(() => {}) }
    render(
      <FileRefContext.Provider value={files}>
        <MarkdownBlock content={`[the app](${url})`} />
      </FileRefContext.Provider>,
    )
    const user = userEvent.setup()
    screen.getByRole('link', { name: 'the app' }).focus()
    await user.keyboard('{Enter}')
    expect(files.openPreview).toHaveBeenCalledWith({ kind: 'url', url })

    await user.keyboard('{Shift>}{F10}{/Shift}')
    await user.click(screen.getByRole('menuitem', { name: 'Open link' }))
    expect(files.openPreview).toHaveBeenCalledTimes(2)
  })

  it.each([
    'https://example.com',
    'http://localhost.example.com:3000',
    'http://127.0.0.1.example.com:3000',
    'http://localhost@external.example:3000',
  ])('keeps %s as an external link', (url) => {
    const files = { ...opener(), openPreview: mock(() => {}) }
    render(
      <FileRefContext.Provider value={files}>
        <MarkdownBlock content={`[the site](${url})`} />
      </FileRefContext.Provider>,
    )

    const link = screen.getByRole('link', { name: 'the site' })
    expect(link.getAttribute('target')).toBe('_blank')
    expect(files.openPreview).not.toHaveBeenCalled()
  })

  it('does not route non-HTTP URLs to Preview', () => {
    const files = { ...opener(), openPreview: mock(() => {}) }
    render(
      <FileRefContext.Provider value={files}>
        <MarkdownLink href="ftp://localhost:3000">the site</MarkdownLink>
      </FileRefContext.Provider>,
    )
    expect(screen.getByRole('link', { name: 'the site' }).getAttribute('target')).toBe('_blank')
    expect(files.openPreview).not.toHaveBeenCalled()
  })

  it('keeps the browser link when Preview is unavailable', () => {
    render(
      <FileRefContext.Provider value={opener()}>
        <MarkdownBlock content="[the app](http://localhost:5173)" />
      </FileRefContext.Provider>,
    )

    const link = screen.getByRole('link', { name: 'the app' })
    expect(link.getAttribute('target')).toBe('_blank')
  })

  it('keeps the browser link outside a workspace', () => {
    render(<MarkdownBlock content="[the app](http://localhost:5173)" />)
    expect(screen.getByRole('link', { name: 'the app' }).getAttribute('target')).toBe('_blank')
  })
})

describe('file references in tool output', () => {
  it('links shell output locations', () => {
    const files = opener()
    render(
      <FileRefContext.Provider value={files}>
        <ToolResult toolName="shell" result={'[Failed — exit code 1]\nsrc/a.test.ts:8:3 expected 1'} />
      </FileRefContext.Provider>,
    )

    fireEvent.click(screen.getByRole('button', { name: 'src/a.test.ts:8:3' }))
    expect(files.open).toHaveBeenCalledWith({ path: 'src/a.test.ts', line: 8, column: 3 })
  })

  it('links language-server locations', () => {
    const files = opener()
    render(
      <FileRefContext.Provider value={files}>
        <ToolResult toolName="lsp" operation="find_references" result="useThing (function) | src/hooks/useThing.ts:14:17 | export function useThing()" />
      </FileRefContext.Provider>,
    )

    fireEvent.click(screen.getByRole('button', { name: /src\/hooks\/useThing\.ts/ }))
    expect(files.open).toHaveBeenCalledWith({ path: 'src/hooks/useThing.ts', line: 14, column: 17 })
  })
})
