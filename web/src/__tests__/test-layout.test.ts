/**
 * Where a test lives. A test named for a source file or folder
 * (`SessionRow.rename.test.tsx` for `components/Sidebar/SessionRow.tsx`)
 * sits at the same path under `__tests__/`, so the tests of a file are
 * found from its path alone. A suite named for a behaviour that crosses
 * files (`reduced-motion`, `design-lint`) has no source of its name and may
 * sit wherever it reads best.
 */
import { describe, expect, it } from 'bun:test'
import { readdirSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const SRC = fileURLToPath(new URL('..', import.meta.url))
const TESTS = join(SRC, '__tests__')

/** `SegmentedControl`, `segmented-control` and `_segmented_control` are one name. */
const norm = (name: string) => name.toLowerCase().replace(/[^a-z0-9.]/g, '')

function walk(dir: string, skip: string | null, out: { path: string; isDir: boolean }[] = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (path === skip || entry.name === 'node_modules') continue
    out.push({ path, isDir: entry.isDirectory() })
    if (entry.isDirectory()) walk(path, skip, out)
  }
  return out
}

describe('test layout', () => {
  it('keeps a test named for a source at the path that mirrors it', () => {
    // name -> the folders (relative to src) that hold a source of that name
    const sources = new Map<string, Set<string>>()
    for (const { path, isDir } of walk(SRC, TESTS)) {
      const file = path.slice(dirname(path).length + 1)
      if (!isDir && (!/\.tsx?$/.test(file) || file.endsWith('.d.ts'))) continue
      const name = norm(isDir ? file : file.replace(/\.tsx?$/, ''))
      const dirs = sources.get(name) ?? new Set<string>()
      sources.set(name, dirs.add(relative(SRC, dirname(path))))
    }

    const misplaced: string[] = []
    let named = 0
    for (const { path, isDir } of walk(TESTS, null)) {
      if (isDir || !/\.test\.tsx?$/.test(path)) continue
      const dir = relative(TESTS, dirname(path))
      const parts = path.slice(dirname(path).length + 1).split('.test.')[0].split('.')
      // `Sidebar.search.keyboard` is tried as itself, then `Sidebar.search`, then `Sidebar`.
      const dirs = parts.map((_, i) => sources.get(norm(parts.slice(0, parts.length - i).join('.')))).find(Boolean)
      if (!dirs) continue
      named += 1
      if (!dirs.has(dir)) misplaced.push(`${relative(TESTS, path)} -> move to __tests__/${[...dirs].join('/ or __tests__/')}/`)
    }

    expect(misplaced).toEqual([])
    expect(named).toBeGreaterThan(500)
  })
})
