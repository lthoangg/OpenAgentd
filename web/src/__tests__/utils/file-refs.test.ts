import { describe, expect, it } from 'bun:test'

import {
  documentRefCandidates,
  findFileRefs,
  parseFileHref,
  parseFileRef,
  parseMentionRef,
  resolveDocumentRef,
  resolveWorkspaceRef,
  workspaceRelativePath,
} from '@/utils/file-refs'

describe('parseMentionRef — an @-mention or design feedback source', () => {
  it('keeps the #L line range of the mention', () => {
    expect(parseMentionRef('src/App.tsx#L42-L71')).toEqual({ path: 'src/App.tsx', line: 42, endLine: 71 })
    expect(parseMentionRef('src/App.tsx#L42-71')).toEqual({ path: 'src/App.tsx', line: 42, endLine: 71 })
    expect(parseMentionRef('src/App.tsx#L42')).toEqual({ path: 'src/App.tsx', line: 42 })
    expect(parseMentionRef('src/App.tsx#L42-L42')).toEqual({ path: 'src/App.tsx', line: 42 })
  })

  it('takes a mention without a range, or with a bad one, as the whole file', () => {
    expect(parseMentionRef('src/App.tsx')).toEqual({ path: 'src/App.tsx' })
    expect(parseMentionRef('src/App.tsx#L0')).toEqual({ path: 'src/App.tsx' })
    expect(parseMentionRef('src/App.tsx#readme')).toEqual({ path: 'src/App.tsx' })
  })
})

describe('parseFileRef — a whole code span', () => {
  it('reads a path with a line, a column, or a GitHub-style anchor', () => {
    expect(parseFileRef('src/a.ts')).toEqual({ path: 'src/a.ts' })
    expect(parseFileRef('src/a.ts:12')).toEqual({ path: 'src/a.ts', line: 12 })
    expect(parseFileRef('src/a.ts:12:5')).toEqual({ path: 'src/a.ts', line: 12, column: 5 })
    expect(parseFileRef('src/a.ts#L7')).toEqual({ path: 'src/a.ts', line: 7 })
    expect(parseFileRef('./web/src/App.tsx')).toEqual({ path: './web/src/App.tsx' })
  })

  it('reads a line range, as start-end or a GitHub anchor', () => {
    expect(parseFileRef('src/a.ts:12-18')).toEqual({ path: 'src/a.ts', line: 12, endLine: 18 })
    expect(parseFileRef('src/a.ts:12–18')).toEqual({ path: 'src/a.ts', line: 12, endLine: 18 })
    expect(parseFileRef('src/a.ts#L7-L9')).toEqual({ path: 'src/a.ts', line: 7, endLine: 9 })
    expect(parseFileRef('src/a.ts#L7C2-L9C4')).toEqual({ path: 'src/a.ts', line: 7, column: 2, endLine: 9 })
  })

  it('keeps the start of a range that does not run forward', () => {
    expect(parseFileRef('src/a.ts:12-12')).toEqual({ path: 'src/a.ts', line: 12 })
    expect(parseFileRef('src/a.ts:18-12')).toEqual({ path: 'src/a.ts', line: 18 })
  })

  it('takes a bare file name only with a known extension', () => {
    expect(parseFileRef('package.json')).toEqual({ path: 'package.json' })
    expect(parseFileRef('a.ts:3')).toEqual({ path: 'a.ts', line: 3 })
    expect(parseFileRef('config.enabled')).toBeNull()
    expect(parseFileRef('useAgentStore.getState')).toBeNull()
  })

  it('leaves code, versions, URLs, and packages alone', () => {
    for (const text of ['v1.2.3', 'npm test', 'foo()', 'https://x.dev/a.ts', '@tanstack/react-query', 'a.ts:0', '']) {
      expect(parseFileRef(text)).toBeNull()
    }
  })
})

describe('parseFileHref — a Markdown link target', () => {
  it('reads relative targets, with anchors and escapes', () => {
    expect(parseFileHref('src/a.ts#L3')).toEqual({ path: 'src/a.ts', line: 3 })
    expect(parseFileHref('src/a.ts:4')).toEqual({ path: 'src/a.ts', line: 4 })
    expect(parseFileHref('src/a.ts#L3-L5')).toEqual({ path: 'src/a.ts', line: 3, endLine: 5 })
    expect(parseFileHref('src/a.ts:4-6')).toEqual({ path: 'src/a.ts', line: 4, endLine: 6 })
    expect(parseFileHref('docs/my%20guide.md')).toEqual({ path: 'docs/my guide.md' })
    expect(parseFileHref('Makefile')).toEqual({ path: 'Makefile' })
  })

  it('leaves URLs, page anchors, and other schemes to the browser', () => {
    for (const href of ['https://x.dev/a.ts', '//x.dev/a.ts', '#usage', 'mailto:me@x.dev', 'file.ts?raw', '']) {
      expect(parseFileHref(href)).toBeNull()
    }
  })
})

describe('findFileRefs — free text such as tool output', () => {
  it('finds compiler, test-runner, and grep locations', () => {
    const text = 'src/a.ts:12:5: error TS2322\n    at run (/repo/src/b.js:3:9)\nREADME.md:4:# Title'
    expect(findFileRefs(text).map(({ start, end, ref }) => [text.slice(start, end), ref])).toEqual([
      ['src/a.ts:12:5', { path: 'src/a.ts', line: 12, column: 5 }],
      ['/repo/src/b.js:3:9', { path: '/repo/src/b.js', line: 3, column: 9 }],
      ['README.md:4', { path: 'README.md', line: 4 }],
    ])
  })

  it('takes a line range whole, and only a line when no end number follows', () => {
    const text = 'see web/src/a.ts:10-20 and b.ts:3-x'
    expect(findFileRefs(text).map(({ start, end, ref }) => [text.slice(start, end), ref])).toEqual([
      ['web/src/a.ts:10-20', { path: 'web/src/a.ts', line: 10, endLine: 20 }],
      ['b.ts:3', { path: 'b.ts', line: 3 }],
    ])
  })

  it('wants a folder or a line before it calls a word a file', () => {
    expect(findFileRefs('Wrote package.json, e.g. to x.dev')).toEqual([])
    expect(findFileRefs('see https://x.dev/docs/a.js for more')).toEqual([])
    expect(findFileRefs('moved to web/src/App.tsx.').map((match) => match.ref)).toEqual([{ path: 'web/src/App.tsx' }])
  })
})

describe('workspaceRelativePath', () => {
  it('resolves relative and in-workspace absolute paths', () => {
    expect(workspaceRelativePath('./src/a.ts', '/repo')).toBe('src/a.ts')
    expect(workspaceRelativePath('/repo/src/a.ts', '/repo/')).toBe('src/a.ts')
    expect(workspaceRelativePath('src/a.ts', '/repo')).toBe('src/a.ts')
  })

  it('rejects paths outside the workspace', () => {
    expect(workspaceRelativePath('/other/a.ts', '/repo')).toBeNull()
    expect(workspaceRelativePath('/repository/a.ts', '/repo')).toBeNull()
    expect(workspaceRelativePath('../a.ts', '/repo')).toBeNull()
    expect(workspaceRelativePath('~/a.ts', '/repo')).toBeNull()
  })
})

describe('resolveWorkspaceRef — which listed file a reference means', () => {
  const files = [
    'README.md',
    'web/README.md',
    'web/src/components/Button.tsx',
    'web/src/components/IconButton.tsx',
    'web/src/index.ts',
    'app/src/index.ts',
  ]

  it('takes the file at that exact path', () => {
    expect(resolveWorkspaceRef('README.md', files)).toEqual({ kind: 'file', path: 'README.md' })
  })

  it('finds a bare name or a partial path by its trailing segments', () => {
    expect(resolveWorkspaceRef('Button.tsx', files)).toEqual({ kind: 'file', path: 'web/src/components/Button.tsx' })
    expect(resolveWorkspaceRef('components/Button.tsx', files)).toEqual({ kind: 'file', path: 'web/src/components/Button.tsx' })
  })

  it('prefers the matching file this session touched most recently', () => {
    const touched = ['app/src/index.ts', 'web/src/index.ts', 'web/README.md']

    expect(resolveWorkspaceRef('src/index.ts', files, touched)).toEqual({ kind: 'file', path: 'app/src/index.ts' })
    expect(resolveWorkspaceRef('README.md', files, touched)).toEqual({ kind: 'file', path: 'web/README.md' })
  })

  it('lists every match when several files fit and none was touched', () => {
    expect(resolveWorkspaceRef('index.ts', files, ['web/src/components/Button.tsx'])).toEqual({
      kind: 'ambiguous',
      paths: ['web/src/index.ts', 'app/src/index.ts'],
    })
  })

  it('reports a reference no listed file ends with', () => {
    expect(resolveWorkspaceRef('Missing.tsx', files)).toEqual({ kind: 'missing' })
    expect(resolveWorkspaceRef('ents/Button.tsx', files)).toEqual({ kind: 'missing' })
  })
})

describe('resolveDocumentRef — a link in a workspace Markdown file', () => {
  const listed = new Set(['README.md', 'setup.md', 'docs/README.md', 'docs/guide.md', 'docs/api/index.md', 'src/app.ts'])
  const isListed = (path: string) => listed.has(path)
  const resolve = (path: string, truncated = false) =>
    resolveDocumentRef('docs/README.md', path, '/repo', isListed, truncated)

  it("reads a relative path from the file's folder first", () => {
    expect(resolve('guide.md')).toEqual({ kind: 'file', path: 'docs/guide.md' })
    expect(resolve('./api/index.md')).toEqual({ kind: 'file', path: 'docs/api/index.md' })
    expect(resolve('../setup.md')).toEqual({ kind: 'file', path: 'setup.md' })
    // The file's own folder wins over a root file of the same name.
    expect(resolve('README.md')).toEqual({ kind: 'file', path: 'docs/README.md' })
  })

  it('falls back to the workspace root, for code spans such as src/app.ts', () => {
    expect(resolve('src/app.ts')).toEqual({ kind: 'file', path: 'src/app.ts' })
  })

  it('reads a leading slash as the workspace root, and the absolute root path as itself', () => {
    expect(resolve('/setup.md')).toEqual({ kind: 'file', path: 'setup.md' })
    expect(resolve('/repo/src/app.ts')).toEqual({ kind: 'file', path: 'src/app.ts' })
  })

  it('reports a path inside the workspace that no listed file has', () => {
    expect(resolve('missing.md')).toEqual({ kind: 'missing' })
  })

  it("opens the folder-relative path when the listing was cut short", () => {
    expect(resolve('missing.md', true)).toEqual({ kind: 'file', path: 'docs/missing.md' })
  })

  it('refuses paths outside the workspace', () => {
    expect(resolve('../../outside.md')).toBeNull()
    expect(resolve('~/notes.md')).toBeNull()
    expect(documentRefCandidates('docs/README.md', '../../outside.md', '/repo')).toEqual([])
  })

  it('lists the folder-relative candidate before the root one, without duplicates', () => {
    expect(documentRefCandidates('docs/README.md', 'src/app.ts', '/repo')).toEqual(['docs/src/app.ts', 'src/app.ts'])
    expect(documentRefCandidates('README.md', 'src/app.ts', '/repo')).toEqual(['src/app.ts'])
    expect(documentRefCandidates('docs/README.md', '../setup.md', '/repo')).toEqual(['setup.md'])
  })
})
