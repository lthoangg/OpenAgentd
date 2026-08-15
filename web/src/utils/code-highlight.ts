/**
 * Syntax highlighting for chat markdown code fences.
 *
 * Built on ``@tanstack/highlight`` rather than highlight.js: it tokenises
 * ~10x faster on the languages we care about and costs a fraction of the
 * bytes, which matters because the desktop and mobile shells pay for this on
 * every app start. The trade is coverage — it ships 26 grammars aimed at
 * documentation, so anything outside ``LANGUAGES`` below renders as escaped
 * plain text rather than throwing.
 *
 * highlight.js is still the highlighter for ``CodingFileViewerPanel`` and the
 * ``ToolCall`` shell command; this module deliberately does not touch them.
 */

import {
  createHighlighter,
  defineLanguage,
  type HighlightToken,
  type HighlightTokenClass,
  type LanguageDefinition,
  type TokenRange,
} from '@tanstack/highlight/core'
import { env } from '@tanstack/highlight/languages/env'
import { js } from '@tanstack/highlight/languages/js'
import { json } from '@tanstack/highlight/languages/json'
import { markdown } from '@tanstack/highlight/languages/markdown'
import { plaintext } from '@tanstack/highlight/languages/plaintext'
import { python } from '@tanstack/highlight/languages/python'
import { shell } from '@tanstack/highlight/languages/shell'
import { ts } from '@tanstack/highlight/languages/ts'
import { tsx } from '@tanstack/highlight/languages/tsx'
import { yaml } from '@tanstack/highlight/languages/yaml'

interface Pattern {
  className: HighlightTokenClass
  regex: RegExp
  /** Capture group to classify instead of the whole match. */
  group?: number
}

/**
 * Build a grammar from an ordered pattern table.
 *
 * First match wins: a region already claimed by an earlier pattern is skipped,
 * which is why comments and strings must come first — otherwise a keyword
 * inside a string literal would be classified as code. This mirrors the helper
 * the bundled grammars use, which lives under the package's ``internal/`` path
 * and is not exported.
 */
function patternLanguage(
  name: string,
  aliases: ReadonlyArray<string>,
  patterns: ReadonlyArray<Pattern>,
): LanguageDefinition {
  return defineLanguage({
    name,
    aliases,
    tokenize(code) {
      const ranges: Array<TokenRange> = []
      const occupied = new Uint8Array(code.length)

      for (const { className, regex, group } of patterns) {
        const scanner = new RegExp(regex.source, regex.flags)
        let match: RegExpExecArray | null
        while ((match = scanner.exec(code)) !== null) {
          if (match[0].length === 0) {
            scanner.lastIndex++
            continue
          }
          const value = group === undefined ? match[0] : match[group]
          if (!value) continue
          const start = match.index + (group === undefined ? 0 : match[0].indexOf(value))
          const end = start + value.length

          let free = true
          for (let i = start; i < end; i++) {
            if (occupied[i]) {
              free = false
              break
            }
          }
          if (!free) continue

          occupied.fill(1, start, end)
          ranges.push({ className, start, end })
        }
      }

      return ranges.sort((a, b) => a.start - b.start)
    },
  })
}

const rust = patternLanguage('rust', ['rs'], [
  { className: 'comment', regex: /\/\/[^\n]*|\/\*[\s\S]*?\*\//g },
  { className: 'string', regex: /r#"[\s\S]*?"#|b?"(?:\\.|[^"\\])*"/g },
  { className: 'meta', regex: /#!?\[[^\]\n]*\]/g },
  { className: 'function', regex: /\bfn\s+([A-Za-z_]\w*)/g, group: 1 },
  { className: 'function', regex: /\b([a-z_]\w*)!/g, group: 1 },
  {
    className: 'keyword',
    regex: /\b(?:as|async|await|break|const|continue|crate|dyn|else|enum|extern|fn|for|if|impl|in|let|loop|match|mod|move|mut|pub|ref|return|static|struct|super|trait|type|unsafe|use|where|while)\b/g,
  },
  { className: 'literal', regex: /\b(?:true|false|None|Some|Ok|Err|self|Self)\b/g },
  {
    className: 'type',
    regex: /\b(?:i8|i16|i32|i64|i128|isize|u8|u16|u32|u64|u128|usize|f32|f64|bool|char|str|String|Vec|Option|Result|Box|Rc|Arc|HashMap|HashSet)\b/g,
  },
  {
    className: 'number',
    regex: /\b(?:0x[\da-fA-F_]+|0b[01_]+|0o[0-7_]+|\d[\d_]*(?:\.\d[\d_]*)?(?:[eE][+-]?\d+)?)(?:[iuf](?:8|16|32|64|128|size))?\b/g,
  },
])

const ini = patternLanguage('ini', ['cfg', 'conf', 'editorconfig', 'gitconfig'], [
  { className: 'comment', regex: /^[ \t]*[;#][^\n]*/gm },
  { className: 'selector', regex: /^[ \t]*\[[^\]\n]*\]/gm },
  { className: 'attr', regex: /^[ \t]*([\w.$-]+)(?=[ \t]*=)/gm, group: 1 },
  { className: 'string', regex: /"(?:\\.|[^"\\\n])*"|'[^'\n]*'/g },
  { className: 'literal', regex: /\b(?:true|false|yes|no|on|off|null)\b/gi },
  { className: 'number', regex: /\b\d+(?:\.\d+)?\b/g },
])

// CSV has no syntax to speak of; the useful signal is "which row is the
// header" plus the quoted/numeric shape of the cells beneath it.
const csv = patternLanguage('csv', ['tsv'], [
  { className: 'heading', regex: /^[^\n]*/g },
  { className: 'string', regex: /"(?:""|[^"])*"/g },
  { className: 'number', regex: /(?<=^|[,\t])[ \t]*-?\d+(?:\.\d+)?[ \t]*(?=[,\t]|$)/gm },
])

const LANGUAGES: ReadonlyArray<LanguageDefinition> = [
  plaintext,
  shell,
  python,
  ts,
  tsx,
  js,
  json,
  yaml,
  markdown,
  env,
  rust,
  ini,
  csv,
]

const highlighter = createHighlighter({ languages: LANGUAGES, fallbackLanguage: 'plaintext' })

/**
 * Tokenise a code fence.
 *
 * Returns tokens rather than an HTML string on purpose: the caller renders
 * them as React elements, so the source is escaped by React and never has to
 * travel through ``dangerouslySetInnerHTML``. An unknown language yields a
 * single unclassified token holding the whole input.
 */
export function tokenizeCode(code: string, language?: string): Array<HighlightToken> {
  return highlighter.tokenize(code, { lang: language }).tokens
}
