/**
 * Wording guard for text people read (DESIGN.md, "Touch follows the input").
 *
 * The same screens run under a mouse and under a finger, so text does not
 * say "click" or "tap" unless it can only be read on one of them. Every
 * such string in the app's source (tests left out, comments ignored) is
 * listed in ``POINTER_VERBS`` with the reason it is right for everyone who
 * sees it; anything else uses a verb that fits both ("open", "choose",
 * "select").
 *
 * The counts are exact, not maxima: fixing a string means deleting its
 * entry, so the list only shrinks. Shortcut glyphs have their own rule in
 * ``design-lint.test.ts`` (``mac-glyph-in-copy``).
 *
 * ``ONE_SPELLING`` holds the words that have a single form everywhere
 * (DESIGN.md, "One name per thing"): a failure starts "Couldn't", the
 * button that tries again is "Retry", what cannot come back "can't be
 * undone", and an unreachable server is "Can't reach".
 */
import { describe, expect, it } from 'bun:test'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const SRC = fileURLToPath(new URL('../', import.meta.url))

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) return name === '__tests__' ? [] : sourceFiles(path)
    return /\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name) ? [path] : []
  })
}

/**
 * The source with every comment blanked (line breaks kept). Quoted strings
 * end at the line's end, so an apostrophe in JSX text ("can't") costs at
 * most the rest of its line.
 */
function stripComments(source: string): string {
  let out = ''
  let state: 'code' | 'single' | 'double' | 'template' | 'line' | 'block' = 'code'
  for (let i = 0; i < source.length; i += 1) {
    const char = source[i]
    const next = source[i + 1]
    if (state === 'line') {
      if (char === '\n') { state = 'code'; out += char }
      continue
    }
    if (state === 'block') {
      if (char === '*' && next === '/') { state = 'code'; i += 1 } else if (char === '\n') out += char
      continue
    }
    if (state === 'code') {
      // "http://": a slash pair after a colon is a URL, not a comment.
      if (char === '/' && next === '/' && source[i - 1] !== ':') { state = 'line'; continue }
      if (char === '/' && next === '*') { state = 'block'; i += 1; continue }
      if (char === "'") state = 'single'
      else if (char === '"') state = 'double'
      else if (char === '`') state = 'template'
      out += char
      continue
    }
    out += char
    if (char === '\\' && next !== undefined && next !== '\n') { out += next; i += 1; continue }
    if (state === 'single' && (char === "'" || char === '\n')) state = 'code'
    else if (state === 'double' && (char === '"' || char === '\n')) state = 'code'
    else if (state === 'template' && char === '`') state = 'code'
  }
  return out
}

const QUOTED = /'(?:[^'\n\\]|\\.)*'|"(?:[^"\n\\]|\\.)*"|`(?:[^`\\]|\\.)*`/g
/** A module path is not text: `} from '@/lib/notification-taps'`. */
const MODULE_PATH = /\bfrom\s+['"][^'"\n]+['"]/g
/** Text after a tag or an expression, up to the next one or the line's end (a backtick means a template, already read). */
const JSX_INLINE = /(?<=[>}])[^<>{}\n=;()`]*[A-Za-z][^<>{}\n=;()`]*(?=[<{]|$)/gm
/** A line of prose inside JSX: starts with a capital, carries no code punctuation. */
const JSX_LINE = /^[ \t]*[A-Z][^<>{}\n=;()]*$/gm

/** Every piece of literal text in a source: quoted strings and JSX text. */
function literalText(source: string): string[] {
  const code = stripComments(source).replace(MODULE_PATH, '')
  return [...(code.match(QUOTED) ?? []), ...(code.match(JSX_INLINE) ?? []), ...(code.match(JSX_LINE) ?? [])]
}

const POINTER_VERB = /\b(?:double-|right-)?(?:click|tap)(?:s|ped|ping|ked|king)?\b/i

/** Prose that names a pointer or touch gesture ("Tap to edit", "click Open"). An event name has no space. */
function pointerVerbStrings(source: string): string[] {
  return [...new Set(literalText(source).filter((text) => /\s/.test(text.trim()) && POINTER_VERB.test(text)))]
}

/** Strings that say click or tap, per file, each right for every device that shows it. */
const POINTER_VERBS: Record<string, { count: number; why: string }> = {
  'components/AppBackendPanel.tsx': { count: 1, why: 'the touch branch of the list description; the other branch names the Use button' },
  'components/PendingMessageQueue.tsx': { count: 1, why: 'the phone-only queued bubble' },
  'components/Preview/PreviewTabView.tsx': { count: 2, why: 'the commenting line: "Tap" in the phone branch, "Click" in the desktop one' },
  'components/account/InviteSheet.tsx': { count: 2, why: 'says what to do on the phone that scans the code' },
  'components/settings/pages/account-copy.tsx': { count: 1, why: 'a computer says what to do on the phone that scanned it' },
  'components/settings/pages/settings.account.phone.tsx': { count: 1, why: 'the phone says what to do on the other phone' },
  'components/settings/pages/settings.account.tsx': { count: 1, why: 'a computer says what to do on the phone that adds it' },
  'components/phone/NewDeviceSignIn.tsx': { count: 3, why: 'the phone-only first screen, about this phone and the other one' },
  'components/phone/AccountSection.tsx': { count: 1, why: 'the phone-only Computers screen, about the other phone' },
  'components/phone/AddScannedSheet.tsx': { count: 2, why: 'the phone-only sheet, about the new iPhone or iPad (a computer gets Pick)' },
  'components/settings/pages/settings.desktop.tsx': { count: 1, why: 'the notch setting: macOS desktop only' },
  'components/settings/settings-index.ts': { count: 1, why: 'a search keyword, never shown' },
  'components/WorkspacePanel/DockTabBar.tsx': { count: 1, why: 'a tooltip, which only a pointer shows' },
  'hooks/use-panel-resize.ts': { count: 1, why: 'the resize handle tooltip, which only a pointer shows' },
}

/** The text of a literal without its quotes and outer space. */
function bare(text: string): string {
  return text.trim().replace(/^(['"`])([\s\S]*)\1$/, '$2').trim()
}

/** Wording with one spelling: each rule names what to write instead. */
const ONE_SPELLING: { name: string; use: string; matches: (text: string) => boolean }[] = [
  { name: 'failure-opener', use: `"Couldn't …"`, matches: (text) => /\b(?:Could not|Unable to|Failed to)\b/.test(text) },
  { name: 'try-again-button', use: '"Retry"', matches: (text) => bare(text) === 'Try again' },
  { name: 'cannot-be-undone', use: `"This can't be undone."`, matches: (text) => /cannot be undone|\bfor good\b/i.test(text) },
  { name: 'ampersand-send', use: '"Stop and send"', matches: (text) => /Stop (?:&|&amp;) send/.test(text) },
  { name: 'unreachable', use: `"Can't reach {name}"`, matches: (text) => bare(text) === 'Offline' || /Server (?:unreachable|not reachable)/.test(text) },
]

function spellingProblems(file: string, source: string): string[] {
  return literalText(source).flatMap((text) =>
    ONE_SPELLING.filter((rule) => rule.matches(text)).map((rule) => `${file}: ${rule.name}, write ${rule.use}\n    ${text.trim()}`),
  )
}

describe('the scanner', () => {
  it('reads strings and JSX text, not comments or code', () => {
    const source = [
      "// Tap to edit is the phone's wording",
      'const tapped = armed',
      "window.addEventListener('click', handler)",
      'for (const tap of taps) open(tap)',
      "const title = 'Click to expand'",
      '<span>{label} · Tap to edit</span>',
      "import type { NotificationTarget } from '@/lib/notification-taps'",
      '{/* a double-click here',
      '    maximizes the window */}',
      '<p>',
      '  On your phone, tap Scan QR code.',
      '</p>',
      'const hint = `${sorted} · click to filter`',
    ].join('\n')
    expect(pointerVerbStrings(source)).toEqual([
      "'Click to expand'",
      '`${sorted} · click to filter`',
      ' · Tap to edit',
      '  On your phone, tap Scan QR code.',
    ])
  })

  it('keeps a URL whole and ends a string at the end of its line', () => {
    expect(stripComments("const url = 'http://host' // trailing\n<p>can't</p> // gone\nconst a = 1 /* b */ + 2")).toBe(
      "const url = 'http://host' \n<p>can't</p> // gone\nconst a = 1  + 2",
    )
  })

  it('flags each word that has one spelling, and leaves a sentence that merely contains it', () => {
    const source = [
      "const title = 'Could not pin session'",
      "setError('Unable to open workspace')",
      '<Button>Try again</Button>',
      "const body = 'The reset was refused. Try again later.'",
      '<p>This cannot be undone.</p>',
      "const label = 'Stop & send'",
      "return 'Offline'",
      "const hint = 'Works offline too'",
    ].join('\n')
    expect(spellingProblems('x.tsx', source).map((line) => line.split(',')[0])).toEqual([
      'x.tsx: failure-opener',
      'x.tsx: failure-opener',
      'x.tsx: ampersand-send',
      'x.tsx: unreachable',
      'x.tsx: try-again-button',
      'x.tsx: cannot-be-undone',
    ])
  })
})

describe('wording', () => {
  const files = sourceFiles(SRC).map((path) => ({ file: relative(SRC, path), source: readFileSync(path, 'utf8') }))

  it('says click or tap only where one device reads it', () => {
    const found: Record<string, string[]> = {}
    for (const { file, source } of files) {
      const strings = pointerVerbStrings(source)
      if (strings.length > 0) found[file] = strings
    }
    const problems = [
      ...Object.entries(found)
        .filter(([file, strings]) => strings.length !== (POINTER_VERBS[file]?.count ?? 0))
        .map(([file, strings]) => `${file}: ${strings.length} (listed ${POINTER_VERBS[file]?.count ?? 0})\n    ${strings.join('\n    ')}`),
      ...Object.keys(POINTER_VERBS).filter((file) => !found[file]).map((file) => `${file}: listed but clean, delete its entry`),
    ]
    expect(problems).toEqual([])
  })

  it('spells a failure, a retry, no way back and an unreachable server one way', () => {
    expect(files.flatMap(({ file, source }) => spellingProblems(file, source))).toEqual([])
  })
})
