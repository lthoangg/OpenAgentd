import { describe, expect, it } from 'bun:test'

import {
  createFileLinkProvider,
  findTerminalFileLinks,
  isFileLinkActivation,
  parseOsc7Cwd,
  resolveTerminalPath,
  type LinkBuffer,
} from '@/components/Terminal/terminal-links'
import type { FileRef } from '@/utils/file-refs'

const refs = (text: string) => findTerminalFileLinks(text).map(({ text: t, ref }) => ({ t, ...ref }))

describe('findTerminalFileLinks', () => {
  it('finds path:line and path:line:column', () => {
    expect(refs('error at src/foo.ts:42 now')).toEqual([{ t: 'src/foo.ts:42', path: 'src/foo.ts', line: 42 }])
    expect(refs('src/foo.ts:42:7: unexpected token')).toEqual([{ t: 'src/foo.ts:42:7', path: 'src/foo.ts', line: 42, column: 7 }])
  })

  it('finds the parenthesised line,column form of MSBuild/tsc', () => {
    expect(refs('./a/b.rs(10,3): error')).toEqual([{ t: './a/b.rs(10,3)', path: './a/b.rs', line: 10, column: 3 }])
    expect(refs('lib/x.cs(7)')).toEqual([{ t: 'lib/x.cs(7)', path: 'lib/x.cs', line: 7 }])
  })

  it('finds absolute paths and folder paths with an extension', () => {
    expect(refs('File "/abs/path/file.py", line 3')).toEqual([{ t: '/abs/path/file.py', path: '/abs/path/file.py' }])
    expect(refs('/abs/path/file.py:3')).toEqual([{ t: '/abs/path/file.py:3', path: '/abs/path/file.py', line: 3 }])
    expect(refs('modified: a/b.tsx')).toEqual([{ t: 'a/b.tsx', path: 'a/b.tsx' }])
  })

  it('stays out of the punctuation around a path', () => {
    expect(refs('(src/foo.ts:42)')).toEqual([{ t: 'src/foo.ts:42', path: 'src/foo.ts', line: 42 }])
    expect(refs('see src/foo.ts.')).toEqual([{ t: 'src/foo.ts', path: 'src/foo.ts' }])
  })

  it('does not link versions, times, bare words or plain properties', () => {
    for (const text of ['1.2.3', 'v1.2.3-beta', 'at 12:30', 'hello world', 'config.enabled', 'e.g. this', 'node_modules/foo', 'port 3000']) {
      expect(refs(text)).toEqual([])
    }
  })

  it('leaves URLs to the web-links addon', () => {
    expect(refs('open https://example.com/a/b.ts:3 now')).toEqual([])
    expect(refs('git@github.com:org/repo/file.ts and http://localhost:5173/src/main.ts')).toEqual([])
  })

  it('finds a bare file name only with a line number', () => {
    expect(refs('main.rs:12')).toEqual([{ t: 'main.rs:12', path: 'main.rs', line: 12 }])
    expect(refs('main.rs alone')).toEqual([])
  })
})

describe('resolveTerminalPath', () => {
  const ws = '/repo/app'

  it('resolves a relative path against the shell cwd when known', () => {
    expect(resolveTerminalPath('a/b.ts', '/repo/app/web', ws)).toBe('web/a/b.ts')
    expect(resolveTerminalPath('./a.ts', '/repo/app/web/', ws)).toBe('web/a.ts')
    expect(resolveTerminalPath('../a.ts', '/repo/app/web', ws)).toBe('a.ts')
  })

  it('falls back to the workspace root without a cwd', () => {
    expect(resolveTerminalPath('src/a.ts', null, ws)).toBe('src/a.ts')
    expect(resolveTerminalPath('./src/a.ts', null, ws)).toBe('src/a.ts')
  })

  it('maps absolute paths inside the workspace to workspace-relative ones', () => {
    expect(resolveTerminalPath('/repo/app/src/a.ts', null, ws)).toBe('src/a.ts')
    expect(resolveTerminalPath('/repo/app/src/a.ts', '/elsewhere', ws)).toBe('src/a.ts')
  })

  it('refuses paths outside the workspace', () => {
    expect(resolveTerminalPath('/etc/hosts', null, ws)).toBeNull()
    expect(resolveTerminalPath('/repo/other/a.ts', null, ws)).toBeNull()
    expect(resolveTerminalPath('../a.ts', null, ws)).toBeNull()
    expect(resolveTerminalPath('~/a.ts', '/repo/app', ws)).toBeNull()
    // A relative path from a cwd outside the workspace is outside too.
    expect(resolveTerminalPath('a.ts', '/tmp', ws)).toBeNull()
    expect(resolveTerminalPath('../../x.ts', '/repo/app/web', ws)).toBeNull()
  })

  it('has nothing to resolve against without a workspace', () => {
    expect(resolveTerminalPath('a.ts', '/repo', null)).toBeNull()
  })
})

describe('parseOsc7Cwd', () => {
  it('reads the path of a file:// URL', () => {
    expect(parseOsc7Cwd('file://my-host/Users/me/proj')).toBe('/Users/me/proj')
    expect(parseOsc7Cwd('file:///Users/me/proj')).toBe('/Users/me/proj')
  })

  it('decodes percent escapes', () => {
    expect(parseOsc7Cwd('file://h/Users/me/my%20proj/%C3%A9')).toBe('/Users/me/my proj/é')
  })

  it('turns a Windows drive path into a drive path', () => {
    expect(parseOsc7Cwd('file://PC/C:/Users/me')).toBe('C:/Users/me')
    expect(parseOsc7Cwd('file:///C:/Users/me')).toBe('C:/Users/me')
  })

  it('ignores anything that is not a file URL', () => {
    expect(parseOsc7Cwd('')).toBeNull()
    expect(parseOsc7Cwd('/just/a/path')).toBeNull()
    expect(parseOsc7Cwd('https://example.com/x')).toBeNull()
    expect(parseOsc7Cwd('file://host')).toBeNull()
  })
})

describe('isFileLinkActivation', () => {
  const click = (init: MouseEventInit) => new MouseEvent('click', init)
  it('needs ⌘ on macOS and Ctrl elsewhere; a plain click only selects', () => {
    expect(isFileLinkActivation(click({ metaKey: true }), 'macos')).toBe(true)
    expect(isFileLinkActivation(click({ ctrlKey: true }), 'macos')).toBe(false)
    expect(isFileLinkActivation(click({ ctrlKey: true }), 'linux')).toBe(true)
    expect(isFileLinkActivation(click({ metaKey: true }), 'windows')).toBe(false)
    expect(isFileLinkActivation(click({}), 'macos')).toBe(false)
    expect(isFileLinkActivation(click({}), 'linux')).toBe(false)
  })
})

/** A buffer of fixed-width rows; ``wide`` marks a double-width char at a column (the next cell is empty width 0). */
function bufferOf(rows: Array<{ text: string; wrapped?: boolean }>, cols: number): LinkBuffer {
  return {
    cols,
    length: rows.length,
    getLine(index) {
      const row = rows[index]
      if (!row) return undefined
      const chars = row.text.padEnd(cols, ' ').split('')
      return {
        isWrapped: row.wrapped === true,
        getCell: (x) => {
          const ch = chars[x]
          if (ch === undefined) return undefined
          return { getChars: () => (ch === ' ' ? '' : ch), getWidth: () => 1 }
        },
      }
    },
  }
}

type ProvidedLink = { range: { start: { x: number; y: number }; end: { x: number; y: number } }; text: string; activate: (e: MouseEvent, t: string) => void }

function provide(buffer: LinkBuffer, y: number, open: (ref: FileRef) => void = () => {}) {
  const provider = createFileLinkProvider({ buffer: () => buffer, open, os: 'linux' })
  let result: ProvidedLink[] | undefined
  provider.provideLinks(y, (links) => { result = links as ProvidedLink[] | undefined })
  return result
}

describe('createFileLinkProvider', () => {
  it('returns the link with a 1-based inclusive range on its row', () => {
    const links = provide(bufferOf([{ text: 'see src/foo.ts:42 ok' }], 40), 1)
    expect(links).toHaveLength(1)
    expect(links![0].text).toBe('src/foo.ts:42')
    expect(links![0].range).toEqual({ start: { x: 5, y: 1 }, end: { x: 17, y: 1 } })
  })

  it('returns nothing for a row without a path', () => {
    expect(provide(bufferOf([{ text: 'nothing here 12:30' }], 40), 1)).toBeUndefined()
  })

  it('joins soft-wrapped rows so a path split by the terminal width is one link', () => {
    const buffer = bufferOf([{ text: 'at src/some/long' }, { text: '/file.ts:9 done', wrapped: true }], 16)
    for (const y of [1, 2]) {
      const links = provide(buffer, y)
      expect(links).toHaveLength(1)
      expect(links![0].text).toBe('src/some/long/file.ts:9')
      expect(links![0].range).toEqual({ start: { x: 4, y: 1 }, end: { x: 10, y: 2 } })
    }
  })

  it('opens the file only on a modified click', () => {
    const opened: FileRef[] = []
    const links = provide(bufferOf([{ text: 'src/a.ts:3:4' }], 30), 1, (ref) => { opened.push(ref) })
    links![0].activate(new MouseEvent('click'), 'src/a.ts:3:4')
    expect(opened).toEqual([])
    links![0].activate(new MouseEvent('click', { ctrlKey: true }), 'src/a.ts:3:4')
    expect(opened).toEqual([{ path: 'src/a.ts', line: 3, column: 4 }])
  })
})
