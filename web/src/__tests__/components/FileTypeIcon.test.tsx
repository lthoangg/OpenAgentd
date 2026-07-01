/**
 * FileTypeIcon — icon resolution logic tests
 *
 * The component is globally mocked in setup.ts (SVG `?url` imports don't run
 * under Bun/happy-dom). We test the exported `resolveFileIcon` function
 * directly — it encapsulates all the mapping logic and is what the component
 * delegates to at runtime.
 *
 * Critical paths:
 *  - Known extensions → correct icon URL fragment
 *  - Filename overrides win over extension (Makefile, Dockerfile, .gitignore)
 *  - Unknown extensions → generic "file" fallback
 *  - Case-insensitive (App.TSX == app.tsx)
 *  - Path segments: only the last segment is used
 *  - .env.example special-case extension
 */

import { describe, expect, it } from 'bun:test'
import { resolveFileIcon } from '@/utils/file-type-icon'

function icon(name: string): string {
  return resolveFileIcon(name)
}

// ── Extension mapping ─────────────────────────────────────────────────────────

describe('resolveFileIcon — extension mapping', () => {
  const cases: Array<[string, string]> = [
    ['script.py',    'python'],
    ['index.ts',     'typescript'],
    ['App.tsx',      'react_ts'],
    ['utils.js',     'javascript'],
    ['Widget.jsx',   'react'],
    ['data.json',    'json'],
    ['readme.md',    'markdown'],
    ['notes.markdown', 'markdown'],
    ['styles.css',   'css'],
    ['layout.html',  'html'],
    ['config.yml',   'yaml'],
    ['config.yaml',  'yaml'],
    ['Cargo.toml',   'toml'],
    ['main.rs',      'rust'],
    ['main.go',      'go'],
    ['query.sql',    'database'],
    ['data.xml',     'xml'],
    ['photo.png',    'image'],
    ['photo.jpg',    'image'],
    ['photo.jpeg',   'image'],
    ['photo.gif',    'image'],
    ['photo.webp',   'image'],
    ['icon.svg',     'image'],
    ['doc.pdf',      'pdf'],
    ['run.sh',       'console'],
    ['run.bash',     'console'],
    ['run.zsh',      'console'],
    ['vars.env',     'settings'],
    ['styles.scss',  'sass'],
  ]

  for (const [filename, fragment] of cases) {
    it(`${filename} → URL containing "${fragment}"`, () => {
      expect(icon(filename)).toContain(fragment)
    })
  }
})

// ── Filename overrides ────────────────────────────────────────────────────────

describe('resolveFileIcon — filename overrides', () => {
  it('Makefile → makefile icon', () => {
    expect(icon('Makefile')).toContain('makefile')
  })

  it('makefile (lowercase) → makefile icon', () => {
    expect(icon('makefile')).toContain('makefile')
  })

  it('Dockerfile → docker icon', () => {
    expect(icon('Dockerfile')).toContain('docker')
  })

  it('.gitignore → git icon', () => {
    expect(icon('.gitignore')).toContain('git')
  })

  it('.env (exact filename) → settings icon', () => {
    expect(icon('.env')).toContain('settings')
  })

  it('.env.example → settings icon via special-case extension', () => {
    expect(icon('.env.example')).toContain('settings')
  })

  // Filename override wins: resolves to makefile stub, not the generic file stub
  it('Makefile filename override wins — not treated as no-extension fallback', () => {
    const result = icon('Makefile')
    expect(result).toContain('makefile')
    expect(result).not.toBe(icon('UNKNOWN_NO_EXT')) // generic fallback value
  })
})

// ── Fallback ──────────────────────────────────────────────────────────────────

describe('resolveFileIcon — fallback', () => {
  it('unknown extension → generic file icon', () => {
    const result = icon('archive.xwp')
    expect(result).toContain('file')
    expect(result).not.toContain('python')
    expect(result).not.toContain('typescript')
  })

  it('no extension → generic file icon', () => {
    expect(icon('LICENSE')).toContain('file')
    expect(icon('LICENCE')).toContain('file')
    expect(icon('README')).toContain('file')
  })

  it('empty string → generic file icon (no crash)', () => {
    expect(icon('')).toContain('file')
  })
})

// ── Case insensitivity ────────────────────────────────────────────────────────

describe('resolveFileIcon — case insensitivity', () => {
  it('App.TSX === App.tsx', () => {
    expect(icon('App.TSX')).toBe(icon('App.tsx'))
  })

  it('Script.PY === script.py', () => {
    expect(icon('Script.PY')).toBe(icon('script.py'))
  })

  it('DATA.JSON === data.json', () => {
    expect(icon('DATA.JSON')).toBe(icon('data.json'))
  })
})

// ── Path segment handling ─────────────────────────────────────────────────────

describe('resolveFileIcon — path segments', () => {
  it('uses only the final segment of a full path', () => {
    expect(icon('src/components/App.tsx')).toBe(icon('App.tsx'))
  })

  it('deeply nested path resolves same as bare filename', () => {
    expect(icon('a/b/c/d/script.py')).toBe(icon('script.py'))
  })

  it('path with unknown extension still falls back to generic', () => {
    expect(icon('deep/nested/archive.xwp')).toContain('file')
  })

  it('path ending with Makefile uses filename override', () => {
    expect(icon('project/Makefile')).toContain('makefile')
  })
})

// ── Determinism ───────────────────────────────────────────────────────────────

describe('resolveFileIcon — determinism', () => {
  it('returns the same value on repeated calls', () => {
    expect(icon('app.py')).toBe(icon('app.py'))
    expect(icon('styles.css')).toBe(icon('styles.css'))
  })

  it('different extensions return different icons', () => {
    expect(icon('file.py')).not.toBe(icon('file.ts'))
    expect(icon('file.json')).not.toBe(icon('file.css'))
  })
})
