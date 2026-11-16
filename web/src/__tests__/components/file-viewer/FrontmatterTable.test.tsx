import { afterEach, describe, expect, it, mock } from 'bun:test'
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'

mock.module('lucide-react', () => new Proxy({}, { get: () => () => null }))

import { FrontmatterTable, FRONTMATTER_COLLAPSED_ROWS } from '@/components/file-viewer/FrontmatterTable'
import { FilePreviewContent } from '@/components/FileViewerPanel'
import { MarkdownBlock } from '@/utils/markdown'
import type { FrontmatterField } from '@/components/file-viewer/frontmatter'
import type { WorkspaceFileInfo } from '@/api/types'

const originalFetch = globalThis.fetch
afterEach(() => {
  cleanup()
  globalThis.fetch = originalFetch
})

const rows = (container: HTMLElement) =>
  Array.from(container.querySelectorAll('tr')).map((tr) => [tr.querySelector('th')?.textContent, tr.querySelector('td')?.textContent])

describe('FrontmatterTable', () => {
  it('renders text, list chips and raw YAML values', () => {
    const fields: FrontmatterField[] = [
      { key: 'title', value: { kind: 'text', text: 'Notes' } },
      { key: 'tools', value: { kind: 'list', items: ['read', 'shell'] } },
      { key: 'colors', value: { kind: 'raw', text: 'primary: "#000"' } },
      { key: 'draft', value: { kind: 'text', text: '' } },
    ]
    const { container } = render(<FrontmatterTable fields={fields} raw="" />)
    expect(rows(container)).toEqual([
      ['title', 'Notes'],
      ['tools', 'readshell'],
      ['colors', 'primary: "#000"'],
      ['draft', '—'],
    ])
    expect(container.querySelectorAll('li')).toHaveLength(2)
    expect(container.querySelector('td pre')?.textContent).toBe('primary: "#000"')
  })

  it('shows the YAML source when it could not be tabulated', () => {
    const { container } = render(<FrontmatterTable fields={null} raw={'title: x\nwords'} />)
    expect(container.querySelector('table')).toBeNull()
    expect(container.querySelector('pre')?.textContent).toBe('title: x\nwords')
  })

  it('renders nothing for an empty block', () => {
    const { container } = render(<FrontmatterTable fields={[]} raw="" />)
    expect(container.innerHTML).toBe('')
  })

  it('collapses long frontmatter until expanded', () => {
    const count = FRONTMATTER_COLLAPSED_ROWS + 3
    const fields: FrontmatterField[] = Array.from({ length: count }, (_, i) => ({ key: `k${i}`, value: { kind: 'text', text: `v${i}` } }))
    const { container } = render(<FrontmatterTable fields={fields} raw="" />)
    expect(container.querySelectorAll('tr')).toHaveLength(FRONTMATTER_COLLAPSED_ROWS)
    act(() => screen.getByRole('button', { name: `Show all ${count} fields` }).click())
    expect(container.querySelectorAll('tr')).toHaveLength(count)
    act(() => screen.getByRole('button', { name: 'Show fewer fields' }).click())
    expect(container.querySelectorAll('tr')).toHaveLength(FRONTMATTER_COLLAPSED_ROWS)
  })

  it('does not offer a toggle for short frontmatter', () => {
    render(<FrontmatterTable fields={[{ key: 'a', value: { kind: 'text', text: 'b' } }]} raw="a: b" />)
    expect(screen.queryByRole('button')).toBeNull()
  })
})

const mdFile: WorkspaceFileInfo = { path: 'docs/notes.md', name: 'notes.md', size: 64, mtime: 1, mime: 'text/markdown' }
const withFrontmatter = '---\ntitle: Notes\ntags: [a, b]\n---\n# Heading\n\nBody text.'

describe('FilePreviewContent — frontmatter', () => {
  it('renders frontmatter as a table above the rendered body', async () => {
    globalThis.fetch = mock(async () => new Response(withFrontmatter)) as unknown as typeof fetch
    const { container } = render(<FilePreviewContent workspace="/w" file={mdFile} markdownView="rendered" />)
    await waitFor(() => expect(container.querySelector('.oa-prose')).not.toBeNull())
    const table = screen.getByRole('region', { name: 'Frontmatter' })
    expect(rows(table)).toEqual([['title', 'Notes'], ['tags', 'ab']])
    // The table sits in the reading column, before the markdown body.
    expect(table.nextElementSibling?.contains(container.querySelector('.oa-prose'))).toBe(true)
    expect(container.querySelector('.oa-prose h1')?.textContent).toBe('Heading')
    expect(container.querySelector('.oa-prose hr')).toBeNull()
    expect(container.querySelector('.oa-prose')?.textContent).not.toContain('title')
  })

  it('renders a file without frontmatter as before, with no table', async () => {
    globalThis.fetch = mock(async () => new Response('# Heading\n\nBody text.')) as unknown as typeof fetch
    const { container } = render(<FilePreviewContent workspace="/w" file={mdFile} markdownView="rendered" />)
    await waitFor(() => expect(container.querySelector('.oa-prose')).not.toBeNull())
    expect(screen.queryByRole('region', { name: 'Frontmatter' })).toBeNull()
    expect(container.querySelector('.oa-prose h1')?.textContent).toBe('Heading')
  })

  it('keeps the YAML in the Source view', async () => {
    globalThis.fetch = mock(async () => new Response(withFrontmatter)) as unknown as typeof fetch
    const { container } = render(<FilePreviewContent workspace="/w" file={mdFile} markdownView="source" />)
    await waitFor(() => expect(container.textContent).toContain('title: Notes'))
    expect(screen.queryByRole('region', { name: 'Frontmatter' })).toBeNull()
  })
})

describe('chat markdown', () => {
  it('does not tabulate frontmatter in agent responses', () => {
    const { container } = render(<MarkdownBlock content={withFrontmatter} />)
    expect(screen.queryByRole('region', { name: 'Frontmatter' })).toBeNull()
    expect(container.textContent).toContain('title: Notes')
  })
})
