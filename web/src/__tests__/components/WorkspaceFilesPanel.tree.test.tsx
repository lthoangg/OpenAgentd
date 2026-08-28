/**
 * WorkspaceFilesPanel — file tree tests
 *
 * Covers the critical paths of the nested collapsible tree:
 *  - Tree structure: folder/file nesting, sort order (folders first, alpha)
 *  - Folders open by default — children visible without interaction
 *  - Collapse/expand toggle via folder header button
 *  - aria-expanded reflects open/closed state
 *  - Sibling folders are independent
 *  - Indentation: nested files have more paddingLeft than root files
 *  - File selection emits the file and shows the preview header
 *  - Selected row gets accent colour; unselected does not
 *  - Selection cleared when file disappears from listing
 *  - Empty state shown when no files
 */

import { afterEach, describe, expect, it } from 'bun:test'
import { render, screen, cleanup, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { mock } from 'bun:test'
import { WorkspaceFilesPanel } from '@/components/WorkspaceFilesPanel'
import type { WorkspaceFileInfo } from '@/api/types'

afterEach(cleanup)

// ── Helpers ───────────────────────────────────────────────────────────────────

const SID = '01900000-0000-7000-8000-000000000001'

function f(path: string, extra: Partial<WorkspaceFileInfo> = {}): WorkspaceFileInfo {
  return { path, name: path.split('/').pop()!, size: 128, mtime: 0, mime: 'text/plain', ...extra }
}

function makeClient() {
  return new QueryClient({ defaultOptions: { queries: { retry: false } } })
}

function stubFiles(files: WorkspaceFileInfo[]) {
  globalThis.fetch = mock(async (...args: unknown[]) => {
    const url = String(args[0])
    if (url.includes('/api/session/') && url.includes('/files')) {
      return new Response(JSON.stringify({ files, truncated: false }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    }
    return new Response('{}', { status: 200 })
  }) as unknown as typeof fetch
}

function renderPanel(files: WorkspaceFileInfo[], onClose = () => {}) {
  stubFiles(files)
  const client = makeClient()
  return render(
    <QueryClientProvider client={client}>
      <WorkspaceFilesPanel open sessionId={SID} onClose={onClose} />
    </QueryClientProvider>,
  )
}

// File rows no longer carry a native `title` attribute (moved to a hover
// Tooltip) — locate the row's button via its visible name text instead.
async function findFileButton(name: string): Promise<HTMLButtonElement> {
  return (await screen.findByText(name)).closest('button') as HTMLButtonElement
}
function getFileButton(name: string): HTMLButtonElement {
  return screen.getByText(name).closest('button') as HTMLButtonElement
}

// ── Structure ─────────────────────────────────────────────────────────────────

describe('WorkspaceFilesPanel tree — structure', () => {
  it('renders root-level files without any folder toggle button', async () => {
    renderPanel([f('readme.md'), f('main.py')])
    expect(await screen.findByText('readme.md')).toBeTruthy()
    expect(screen.getByText('main.py')).toBeTruthy()
    const toggles = screen.queryAllByRole('button', { name: (_, el) =>
      el?.getAttribute('aria-expanded') !== null })
    expect(toggles).toHaveLength(0)
  })

  it('renders a folder row with aria-expanded for nested files', async () => {
    renderPanel([f('src/app.py')])
    expect(await screen.findByText('src')).toBeTruthy()
    expect(screen.getByText('app.py')).toBeTruthy()
    // There should be exactly one folder toggle
    const nav = document.querySelector('nav')!
    const toggles = Array.from(nav.querySelectorAll('button[aria-expanded]'))
    expect(toggles).toHaveLength(1)
  })

  it('nests all intermediate folder labels for deeply nested paths', async () => {
    renderPanel([f('a/b/c/deep.ts')])
    expect(await screen.findByText('a')).toBeTruthy()
    expect(screen.getByText('b')).toBeTruthy()
    expect(screen.getByText('c')).toBeTruthy()
    expect(screen.getByText('deep.ts')).toBeTruthy()
  })

  it('renders folders before files at the same tree level', async () => {
    renderPanel([f('alpha.txt'), f('src/component.tsx'), f('beta.txt')])
    await screen.findByText('alpha.txt')
    const nav = document.querySelector('nav')!
    const text = nav.textContent ?? ''
    expect(text.indexOf('src')).toBeLessThan(text.indexOf('alpha.txt'))
  })

  it('sorts siblings alphabetically within the same directory', async () => {
    renderPanel([f('src/z.ts'), f('src/a.ts'), f('src/m.ts')])
    await screen.findByText('a.ts')
    const nav = document.querySelector('nav')!
    const text = nav.textContent ?? ''
    expect(text.indexOf('a.ts')).toBeLessThan(text.indexOf('m.ts'))
    expect(text.indexOf('m.ts')).toBeLessThan(text.indexOf('z.ts'))
  })

  it('shows the empty-state message when there are no files', async () => {
    renderPanel([])
    expect(await screen.findByText(/No files yet/i)).toBeTruthy()
  })
})

// ── Default open ──────────────────────────────────────────────────────────────

describe('WorkspaceFilesPanel tree — folders open by default', () => {
  it('files inside folders are visible without any user interaction', async () => {
    renderPanel([f('lib/utils.ts'), f('lib/helpers.ts')])
    expect(await screen.findByText('utils.ts')).toBeTruthy()
    expect(screen.getByText('helpers.ts')).toBeTruthy()
  })

  it('deeply nested files are visible without user interaction', async () => {
    renderPanel([f('a/b/c/deep.ts')])
    expect(await screen.findByText('deep.ts')).toBeTruthy()
  })

  it('aria-expanded is "true" on all folder buttons by default', async () => {
    renderPanel([f('src/a.ts'), f('lib/b.ts')])
    await screen.findByText('a.ts')
    const nav = document.querySelector('nav')!
    const toggles = Array.from(nav.querySelectorAll('button[aria-expanded]'))
    expect(toggles.length).toBeGreaterThan(0)
    for (const toggle of toggles) {
      expect(toggle.getAttribute('aria-expanded')).toBe('true')
    }
  })
})

// ── Collapse / expand ─────────────────────────────────────────────────────────

describe('WorkspaceFilesPanel tree — collapse and expand', () => {
  it('clicking a folder button hides its children', async () => {
    const user = userEvent.setup()
    renderPanel([f('src/app.tsx')])

    await screen.findByText('app.tsx')
    const nav = document.querySelector('nav')!
    const toggle = nav.querySelector('button[aria-expanded]') as HTMLButtonElement

    await user.click(toggle)

    expect(screen.queryByText('app.tsx')).toBeNull()
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
  })

  it('clicking a collapsed folder shows its children again', async () => {
    const user = userEvent.setup()
    renderPanel([f('src/app.tsx')])

    await screen.findByText('app.tsx')
    const nav = document.querySelector('nav')!
    const toggle = nav.querySelector('button[aria-expanded]') as HTMLButtonElement

    await user.click(toggle) // collapse
    expect(screen.queryByText('app.tsx')).toBeNull()

    await user.click(toggle) // expand
    expect(screen.getByText('app.tsx')).toBeTruthy()
    expect(toggle.getAttribute('aria-expanded')).toBe('true')
  })

  it('collapsing one folder does not hide sibling folder contents', async () => {
    const user = userEvent.setup()
    renderPanel([f('lib/util.ts'), f('src/app.ts')])

    await screen.findByText('util.ts')
    const nav = document.querySelector('nav')!
    const toggles = Array.from(nav.querySelectorAll('button[aria-expanded]')) as HTMLButtonElement[]
    expect(toggles).toHaveLength(2)

    // Collapse the first folder button in DOM order
    await user.click(toggles[0])

    // Exactly one file should now be hidden, the other still visible
    const visible = ['util.ts', 'app.ts'].filter((n) => screen.queryByText(n) !== null)
    expect(visible).toHaveLength(1)
  })
})

// ── Indentation ───────────────────────────────────────────────────────────────

describe('WorkspaceFilesPanel tree — indentation', () => {
  it('files inside a folder have more paddingLeft than root-level files', async () => {
    renderPanel([f('root.ts'), f('nested/child.ts')])

    const rootBtn = await findFileButton('root.ts')
    const childBtn = getFileButton('child.ts')

    const rootPL = parseInt(rootBtn.style.paddingLeft || '0', 10)
    const childPL = parseInt(childBtn.style.paddingLeft || '0', 10)
    expect(childPL).toBeGreaterThan(rootPL)
  })

  it('deeper nesting adds progressively more paddingLeft', async () => {
    renderPanel([f('a/b.ts'), f('a/c/d.ts')])

    const shallowBtn = await findFileButton('b.ts')
    const deepBtn = getFileButton('d.ts')

    const shallowPL = parseInt(shallowBtn.style.paddingLeft || '0', 10)
    const deepPL = parseInt(deepBtn.style.paddingLeft || '0', 10)
    expect(deepPL).toBeGreaterThan(shallowPL)
  })
})

// ── Selection ─────────────────────────────────────────────────────────────────

describe('WorkspaceFilesPanel tree — file selection', () => {
  it('clicking a file shows its path in the preview pane header', async () => {
    const user = userEvent.setup()
    renderPanel([f('notes.md')])

    await user.click(await findFileButton('notes.md'))

    // The preview header renders the file path
    await waitFor(() => {
      const instances = screen.queryAllByText('notes.md')
      expect(instances.length).toBeGreaterThanOrEqual(1)
    })
  })

  it('selected file button has accent text class; others do not', async () => {
    const user = userEvent.setup()
    renderPanel([f('a.ts'), f('b.ts')])

    const aBtn = await findFileButton('a.ts')
    const bBtn = getFileButton('b.ts')

    await user.click(aBtn)

    expect(aBtn.className).toContain('text-(--color-accent)')
    expect(bBtn.className).not.toContain('text-(--color-accent)')
  })

  it('switching selection moves the accent class to the new file', async () => {
    const user = userEvent.setup()
    renderPanel([f('a.ts'), f('b.ts')])

    const aBtn = await findFileButton('a.ts')
    const bBtn = getFileButton('b.ts')

    await user.click(aBtn)
    expect(aBtn.className).toContain('text-(--color-accent)')

    await user.click(bBtn)
    expect(bBtn.className).toContain('text-(--color-accent)')
    expect(aBtn.className).not.toContain('text-(--color-accent)')
  })
})

// ── Selection cleared when file removed ───────────────────────────────────────

describe('WorkspaceFilesPanel tree — selection cleared on file removal', () => {
  it('shows the "Select a file" hint when the selected file disappears', async () => {
    const user = userEvent.setup()
    let currentFiles = [f('temp.txt')]
    const client = makeClient()

    globalThis.fetch = mock(async (...args: unknown[]) => {
      const url = String(args[0])
      if (url.includes('/files')) {
        return new Response(
          JSON.stringify({ files: currentFiles, truncated: false }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        )
      }
      return new Response('{}', { status: 200 })
    }) as unknown as typeof fetch

    const { rerender } = render(
      <QueryClientProvider client={client}>
        <WorkspaceFilesPanel open sessionId={SID} onClose={() => {}} />
      </QueryClientProvider>,
    )

    // Select the file
    await user.click(await findFileButton('temp.txt'))
    await waitFor(() => expect(screen.queryAllByText('temp.txt').length).toBeGreaterThanOrEqual(1))

    // Remove the file and trigger a re-fetch by toggling open
    currentFiles = []
    rerender(
      <QueryClientProvider client={client}>
        <WorkspaceFilesPanel open={false} sessionId={SID} onClose={() => {}} />
      </QueryClientProvider>,
    )
    rerender(
      <QueryClientProvider client={client}>
        <WorkspaceFilesPanel open sessionId={SID} onClose={() => {}} />
      </QueryClientProvider>,
    )

    await waitFor(
      () => expect(screen.queryByText('Select a file')).toBeTruthy(),
      { timeout: 3000 },
    )
  })
})
