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
    ['notes.md',     'markdown'],
    ['notes.markdown', 'markdown'],
    ['styles.css',   'css'],
    ['layout.html',  'html'],
    ['config.yml',   'yaml'],
    ['config.yaml',  'yaml'],
    ['config.toml',  'toml'],
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
    ['events.jsonl', 'json'],
    ['events.ndjson', 'json'],
    ['tsconfig.base.jsonc', 'json'],
    ['Page.astro',   'astro'],
    ['App.svelte',   'svelte'],
    ['App.vue',      'vue'],
    ['post.mdx',     'mdx'],
    ['data.csv',     'table'],
    ['notes.txt',    'document'],
    ['server.log',   'log'],
    ['Main.java',    'java'],
    ['Main.kt',      'kotlin'],
    ['main.swift',   'swift'],
    ['main.c',       'c'],
    ['main.cpp',     'cpp'],
    ['Program.cs',   'csharp'],
    ['index.php',    'php'],
    ['app.rb',       'ruby'],
    ['init.lua',     'lua'],
    ['main.dart',    'dart'],
    ['schema.prisma', 'prisma'],
    ['schema.graphql', 'graphql'],
    ['main.tf',      'terraform'],
    ['run.ps1',      'powershell'],
    ['styles.less',  'less'],
    ['mod.mts',      'typescript'],
    ['fix.diff',     'diff'],
    ['song.mp3',     'audio'],
    ['clip.mp4',     'video'],
    ['font.woff2',   'font'],
    ['bundle.zip',   'zip'],
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

  it('.env.local → settings icon', () => {
    expect(icon('.env.local')).toContain('settings')
  })

  const named: Array<[string, string]> = [
    ['package.json',       'nodejs'],
    ['tsconfig.json',      'tsconfig'],
    ['bun.lock',           'bun'],
    ['pnpm-lock.yaml',     'pnpm'],
    ['Cargo.toml',         'rust'],
    ['go.mod',             'go-mod'],
    ['docker-compose.yml', 'docker'],
    ['README.md',          'readme'],
    ['LICENSE',            'license'],
    ['AGENTS.md',          'agent'],
    ['vite.config.ts',     'vite'],
    ['astro.config.mjs',   'astro-config'],
  ]
  for (const [filename, fragment] of named) {
    it(`${filename} → URL containing "${fragment}"`, () => {
      expect(icon(filename)).toContain(fragment)
    })
  }

  // Filename override wins: resolves to makefile stub, not the generic file stub
  it('Makefile filename override wins — not treated as no-extension fallback', () => {
    const result = icon('Makefile')
    expect(result).toContain('makefile')
    expect(result).not.toBe(icon('UNKNOWN_NO_EXT')) // generic fallback value
  })
})

// ── Compound extensions ───────────────────────────────────────────────────────

describe('resolveFileIcon — compound extensions', () => {
  it('longest known suffix wins', () => {
    expect(icon('types.d.ts')).toContain('typescript-def')
    expect(icon('app.test.ts')).toContain('test-ts')
    expect(icon('app.spec.js')).toContain('test-js')
  })

  it('an unknown middle part falls through to the last extension', () => {
    expect(icon('app.module.ts')).toBe(icon('app.ts'))
  })

  it('a leading dot is not an extension separator', () => {
    expect(icon('.bashrc')).toContain('file')
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
    expect(icon('NOTES')).toContain('file')
    expect(icon('Procfile_x')).toContain('file')
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
