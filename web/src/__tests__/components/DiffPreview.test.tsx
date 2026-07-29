/**
 * DiffPreview — git-diff text rendering fidelity.
 *
 * Regression tests for the "syntax error in the diff text" bug: content
 * lines whose own text starts with `--` or `++` (YAML/Markdown `---`
 * frontmatter, C-style `counter--;` / `counter++;`) produce diff lines
 * starting with `---` / `+++`, which the old parser misclassified as
 * file-header metadata. Those lines vanished from the rendered diff and
 * every following line number drifted, so the text shown on the panel
 * no longer matched the real file. Context lines also kept their leading
 * marker space, mis-indenting them by one column relative to add/del
 * lines.
 */
import { afterEach, describe, expect, it, mock } from 'bun:test'
import { cleanup, render } from '@testing-library/react'

const Icon = () => null
mock.module('lucide-react', () => ({
  Check: Icon, ChevronDown: Icon, ChevronLeft: Icon, ChevronRight: Icon,
  Copy: Icon, Download: Icon, ExternalLink: Icon, File: Icon, FileText: Icon,
  Folder: Icon, FolderOpen: Icon, GitCompare: Icon, Loader2: Icon, Plus: Icon,
  Pencil: Icon, RefreshCw: Icon, RotateCcw: Icon, Search: Icon,
  TerminalSquare: Icon, Undo2: Icon, X: Icon,
}))
mock.module('@/hooks/useReducedMotion', () => ({ useReducedMotion: () => false }))
mock.module('framer-motion', () => ({
  motion: {
    aside: ({ children, className }: { children: React.ReactNode; className?: string }) => (
      <aside className={className}>{children}</aside>
    ),
  },
}))

afterEach(cleanup)

/** Rows rendered with a line-number gutter, as [lineNo, text] pairs. */
function contentRows(container: HTMLElement): Array<[string, string]> {
  return Array.from(container.querySelectorAll('pre')).map((pre) => {
    const row = pre.closest('div.flex') as HTMLElement
    const lineNo = row.querySelector('span.w-9')?.textContent ?? ''
    return [lineNo, pre.textContent ?? '']
  })
}

async function renderDiff(diff: string) {
  const { DiffPreview } = await import('@/components/CodingFileViewerPanel')
  return render(<DiffPreview diff={diff} />)
}

describe('DiffPreview content parsing', () => {
  it('renders removed/added lines whose content starts with -- or ++', async () => {
    // Old file: ---, title: hello, ---, body, counter--;  (5 lines)
    // New file: title: hello, body2, counter++;           (3 lines)
    const diff = [
      'diff --git a/doc.md b/doc.md',
      'index 26807bb..ad621fb 100644',
      '--- a/doc.md',
      '+++ b/doc.md',
      '@@ -1,5 +1,3 @@',
      '----',
      ' title: hello',
      '----',
      '-body',
      '-counter--;',
      '+body2',
      '+counter++;',
    ].join('\n')

    const { container } = await renderDiff(diff)

    expect(contentRows(container)).toEqual([
      ['1', '---'],           // deleted frontmatter open — was dropped as "meta"
      ['1', 'title: hello'],  // context — leading marker space stripped
      ['3', '---'],           // deleted frontmatter close — was dropped as "meta"
      ['4', 'body'],          // old-file numbering must not drift after the --- lines
      ['5', 'counter--;'],
      ['2', 'body2'],
      ['3', 'counter++;'],
    ])
  })

  it('still hides the real file-header metadata lines', async () => {
    const diff = [
      'diff --git a/a.txt b/a.txt',
      'index 1111111..2222222 100644',
      '--- a/a.txt',
      '+++ b/a.txt',
      '@@ -1 +1 @@',
      '-old',
      '+new',
      '\\ No newline at end of file',
    ].join('\n')

    const { container } = await renderDiff(diff)

    expect(contentRows(container)).toEqual([
      ['1', 'old'],
      ['1', 'new'],
    ])
    expect(container.textContent).not.toContain('a/a.txt')
    expect(container.textContent).not.toContain('No newline')
  })

  it('shows non-hunk header notes (binary files) without a line number', async () => {
    const diff = [
      'diff --git a/logo.png b/logo.png',
      'index 1111111..2222222 100644',
      'Binary files a/logo.png and b/logo.png differ',
    ].join('\n')

    const { container } = await renderDiff(diff)

    expect(contentRows(container)).toEqual([])
    expect(container.textContent).toContain('Binary files a/logo.png and b/logo.png differ')
  })

  it('handles rename headers without leaking them as content', async () => {
    const diff = [
      'diff --git a/old.ts b/new.ts',
      'similarity index 95%',
      'rename from old.ts',
      'rename to new.ts',
      'index 1111111..2222222 100644',
      '--- a/old.ts',
      '+++ b/new.ts',
      '@@ -1,2 +1,2 @@',
      ' keep',
      '-removed',
      '+added',
    ].join('\n')

    const { container } = await renderDiff(diff)

    expect(contentRows(container)).toEqual([
      ['1', 'keep'],
      ['2', 'removed'],
      ['2', 'added'],
    ])
    expect(container.textContent).not.toContain('similarity index')
    expect(container.textContent).not.toContain('rename from')
  })
})
