/**
 * Syntax highlighting for chat markdown code fences.
 *
 * Built on ``@tanstack/highlight`` rather than highlight.js: it tokenises
 * ~10x faster on the languages we care about and costs a fraction of the
 * bytes, which matters because the desktop and mobile shells pay for this on
 * every app start. The trade is coverage — its bundled grammars target
 * documentation, so anything outside ``LANGUAGES`` below renders as escaped
 * plain text rather than throwing. Adding a bundled grammar costs ~100 bytes
 * gzipped; adding a hand-written one costs a pattern table and its tests.
 *
 * This is the app's only highlighter — chat fences, ``CodingFileViewerPanel``
 * and the ``ToolCall`` shell command all resolve their grammars here, so a
 * language added below lights up in every one of those surfaces at once.
 */

import {
  createHighlighter,
  defineLanguage,
  renderNodesToHtml,
  renderTokens,
  type HighlightToken,
  type HighlightTokenClass,
  type LanguageDefinition,
  type TokenRange,
} from '@tanstack/highlight/core'
import { env } from '@tanstack/highlight/languages/env'
import { css } from '@tanstack/highlight/languages/css'
import { diff } from '@tanstack/highlight/languages/diff'
import { dockerfile } from '@tanstack/highlight/languages/dockerfile'
import { html } from '@tanstack/highlight/languages/html'
import { http } from '@tanstack/highlight/languages/http'
import { js } from '@tanstack/highlight/languages/js'
import { json } from '@tanstack/highlight/languages/json'
import { jsx } from '@tanstack/highlight/languages/jsx'
import { markdown } from '@tanstack/highlight/languages/markdown'
import { plaintext } from '@tanstack/highlight/languages/plaintext'
import { python } from '@tanstack/highlight/languages/python'
import { shell } from '@tanstack/highlight/languages/shell'
import { sql } from '@tanstack/highlight/languages/sql'
import { toml } from '@tanstack/highlight/languages/toml'
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
 *
 * When a pattern uses ``group``, the classified text must be the *last*
 * occurrence of that text inside the whole match — every table below puts the
 * capture at the end of its pattern (``fn NAME``, ``func (r *Recv) NAME``), so
 * a receiver or prefix that repeats the name cannot steal the offset.
 *
 * Patterns must avoid lookbehind: it is a parse-time syntax error on Safari
 * before 16.4, which would take out the whole chat renderer rather than one
 * fence. Lookahead is fine everywhere.
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
          const start = match.index + (group === undefined ? 0 : match[0].lastIndexOf(value))
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
  { className: 'number', regex: /(?:^|[,\t])(-?\d+(?:\.\d+)?)(?=[,\t]|$)/gm, group: 1 },
])

const go = patternLanguage('go', ['golang'], [
  { className: 'comment', regex: /\/\/[^\n]*|\/\*[\s\S]*?\*\//g },
  { className: 'string', regex: /`[^`]*`|"(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'/g },
  { className: 'function', regex: /\bfunc\s*\([^)\n]*\)\s*([A-Za-z_]\w*)/g, group: 1 },
  { className: 'function', regex: /\bfunc\s+([A-Za-z_]\w*)/g, group: 1 },
  {
    className: 'keyword',
    regex: /\b(?:break|case|chan|const|continue|default|defer|else|fallthrough|for|func|go|goto|if|import|interface|map|package|range|return|select|struct|switch|type|var)\b/g,
  },
  { className: 'literal', regex: /\b(?:true|false|nil|iota)\b/g },
  {
    className: 'type',
    regex: /\b(?:any|bool|byte|complex64|complex128|error|float32|float64|int|int8|int16|int32|int64|rune|string|uint|uint8|uint16|uint32|uint64|uintptr)\b/g,
  },
  {
    className: 'number',
    regex: /\b(?:0[xX][\da-fA-F_]+|0[bB][01_]+|0[oO][0-7_]+|\d[\d_]*(?:\.\d[\d_]*)?(?:[eE][+-]?\d+)?i?)\b/g,
  },
])

const java = patternLanguage('java', [], [
  { className: 'comment', regex: /\/\/[^\n]*|\/\*[\s\S]*?\*\//g },
  { className: 'string', regex: /"""[\s\S]*?"""|"(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'/g },
  { className: 'meta', regex: /@[A-Za-z_]\w*/g },
  {
    className: 'keyword',
    regex: /\b(?:abstract|assert|break|case|catch|class|const|continue|default|do|else|enum|extends|final|finally|for|goto|if|implements|import|instanceof|interface|native|new|package|private|protected|public|record|return|sealed|static|strictfp|super|switch|synchronized|this|throw|throws|transient|try|var|volatile|while|yield)\b/g,
  },
  { className: 'literal', regex: /\b(?:true|false|null)\b/g },
  {
    className: 'type',
    regex: /\b(?:boolean|byte|char|double|float|int|long|short|void|String|Object|Integer|Long|Double|Boolean|List|Map|Set|Optional)\b/g,
  },
  { className: 'function', regex: /\b([A-Za-z_]\w*)\s*(?=\()/g, group: 1 },
  {
    className: 'number',
    regex: /\b(?:0[xX][\da-fA-F_]+|0[bB][01_]+|\d[\d_]*(?:\.\d[\d_]*)?(?:[eE][+-]?\d+)?[fFdDlL]?)\b/g,
  },
])

const C_COMMENT = /\/\/[^\n]*|\/\*[\s\S]*?\*\//g
const C_PREPROCESSOR = /^[ \t]*#[ \t]*\w+[^\n]*/gm
const C_STRING = /"(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'/g
const C_CALL = /\b([A-Za-z_]\w*)\s*(?=\()/g
const C_NUMBER = /\b(?:0[xX][\da-fA-F']+|0[bB][01']+|\d[\d']*(?:\.\d[\d']*)?(?:[eE][+-]?\d+)?[uUlLfF]*)\b/g

const c = patternLanguage('c', ['h'], [
  { className: 'comment', regex: C_COMMENT },
  { className: 'meta', regex: C_PREPROCESSOR },
  { className: 'string', regex: C_STRING },
  {
    className: 'keyword',
    regex: /\b(?:auto|break|case|const|continue|default|do|else|enum|extern|for|goto|if|inline|register|restrict|return|sizeof|static|struct|switch|typedef|union|volatile|while)\b/g,
  },
  { className: 'literal', regex: /\b(?:NULL|true|false)\b/g },
  {
    className: 'type',
    regex: /\b(?:_Bool|bool|char|double|float|int|long|short|signed|size_t|ssize_t|unsigned|void|FILE|u?int(?:8|16|32|64)_t)\b/g,
  },
  { className: 'function', regex: C_CALL, group: 1 },
  { className: 'number', regex: C_NUMBER },
])

const cpp = patternLanguage('cpp', ['c++', 'cc', 'cxx', 'hpp', 'hh'], [
  { className: 'comment', regex: C_COMMENT },
  { className: 'meta', regex: C_PREPROCESSOR },
  { className: 'string', regex: C_STRING },
  {
    className: 'keyword',
    regex: /\b(?:alignas|auto|break|case|catch|class|const|consteval|constexpr|continue|decltype|default|delete|do|else|enum|explicit|export|extern|final|for|friend|goto|if|inline|mutable|namespace|new|noexcept|operator|override|private|protected|public|register|return|sizeof|static|static_assert|struct|switch|template|this|throw|try|typedef|typename|union|using|virtual|volatile|while)\b/g,
  },
  { className: 'literal', regex: /\b(?:nullptr|NULL|true|false)\b/g },
  {
    className: 'type',
    regex: /\b(?:bool|char|double|float|int|long|short|signed|size_t|std|string|unsigned|void|vector|map|set|unique_ptr|shared_ptr|u?int(?:8|16|32|64)_t)\b/g,
  },
  { className: 'function', regex: C_CALL, group: 1 },
  { className: 'number', regex: C_NUMBER },
])

const ruby = patternLanguage('ruby', ['rb'], [
  { className: 'comment', regex: /#[^\n]*|^=begin[\s\S]*?^=end/gm },
  { className: 'string', regex: /"(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'|%[wWiI]\[[^\]]*\]/g },
  { className: 'function', regex: /\bdef\s+(?:self\.)?([A-Za-z_]\w*[?!=]?)/g, group: 1 },
  {
    className: 'keyword',
    regex: /\b(?:alias|attr_accessor|attr_reader|attr_writer|begin|break|case|class|def|defined\?|do|else|elsif|end|ensure|extend|for|if|in|include|module|next|not|or|and|private|protected|public|raise|redo|require|require_relative|rescue|retry|return|self|super|then|undef|unless|until|when|while|yield)\b/g,
  },
  { className: 'literal', regex: /\b(?:true|false|nil|__FILE__|__LINE__)\b/g },
  { className: 'variable', regex: /@@?\w+|\$\w+/g },
  // The leading guard keeps `Foo::Bar` a scope resolution rather than letting
  // the second colon start a symbol. It cannot be a lookbehind — see
  // `patternLanguage`.
  { className: 'attr', regex: /(?:^|[^:])(:[A-Za-z_]\w*[?!]?)/g, group: 1 },
  { className: 'type', regex: /\b[A-Z]\w*\b/g },
  { className: 'number', regex: /\b\d[\d_]*(?:\.\d[\d_]*)?(?:[eE][+-]?\d+)?\b/g },
])

const graphql = patternLanguage('graphql', ['gql'], [
  { className: 'comment', regex: /#[^\n]*/g },
  { className: 'string', regex: /"""[\s\S]*?"""|"(?:\\.|[^"\\\n])*"/g },
  {
    className: 'keyword',
    regex: /\b(?:directive|enum|extend|fragment|implements|input|interface|mutation|on|query|scalar|schema|subscription|type|union)\b/g,
  },
  { className: 'variable', regex: /\$\w+/g },
  { className: 'literal', regex: /\b(?:true|false|null)\b/g },
  { className: 'type', regex: /\b[A-Z]\w*\b/g },
  { className: 'number', regex: /\b-?\d+(?:\.\d+)?\b/g },
])

const makefile = patternLanguage('makefile', ['make', 'mk'], [
  { className: 'comment', regex: /#[^\n]*/g },
  { className: 'string', regex: /"(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'/g },
  {
    className: 'keyword',
    regex: /\b(?:define|else|endef|endif|export|ifdef|ifeq|ifndef|ifneq|include|override|unexport|vpath)\b/g,
  },
  { className: 'attr', regex: /^([A-Za-z_][\w.]*)[ \t]*(?=[:+?!]?=)/gm, group: 1 },
  { className: 'selector', regex: /^[A-Za-z0-9_./%-]+:(?!=)/gm },
  { className: 'variable', regex: /\$[({][\w.]+[)}]|\$\w/g },
  { className: 'number', regex: /\b\d+(?:\.\d+)?\b/g },
])

const scss = patternLanguage('scss', ['sass'], [
  { className: 'comment', regex: /\/\/[^\n]*|\/\*[\s\S]*?\*\//g },
  { className: 'string', regex: /"(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'/g },
  { className: 'variable', regex: /\$[\w-]+/g },
  { className: 'keyword', regex: /@[a-z-]+/g },
  { className: 'literal', regex: /#[0-9a-fA-F]{3,8}\b/g },
  { className: 'property', regex: /\b[a-z-]+(?=[ \t]*:)/g },
  { className: 'selector', regex: /[.#&][\w-]+/g },
  { className: 'number', regex: /-?\b\d+(?:\.\d+)?(?:px|em|rem|ex|ch|vh|vw|%|s|ms|deg|fr)?\b/g },
])

const kotlin = patternLanguage('kotlin', ['kt', 'kts'], [
  { className: 'comment', regex: /\/\/[^\n]*|\/\*[\s\S]*?\*\//g },
  { className: 'string', regex: /"""[\s\S]*?"""|"(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'/g },
  { className: 'meta', regex: /@[A-Za-z_]\w*/g },
  { className: 'function', regex: /\bfun\s+(?:<[^>\n]*>\s*)?([A-Za-z_]\w*)/g, group: 1 },
  {
    className: 'keyword',
    regex: /\b(?:abstract|actual|annotation|as|break|by|catch|class|companion|const|constructor|continue|crossinline|data|do|dynamic|else|enum|expect|external|final|finally|for|fun|get|if|import|in|infix|init|inline|inner|interface|internal|is|lateinit|noinline|object|open|operator|out|override|package|private|protected|public|reified|return|sealed|set|super|suspend|tailrec|this|throw|try|typealias|val|var|vararg|when|where|while)\b/g,
  },
  { className: 'literal', regex: /\b(?:true|false|null)\b/g },
  {
    className: 'type',
    regex: /\b(?:Any|Array|Boolean|Byte|Char|Double|Float|Int|List|Long|Map|Nothing|Number|Set|Short|String|Unit)\b/g,
  },
  { className: 'number', regex: /\b(?:0[xX][\da-fA-F_]+|0[bB][01_]+|\d[\d_]*(?:\.\d[\d_]*)?(?:[eE][+-]?\d+)?[fFlLuU]?)\b/g },
])

const swift = patternLanguage('swift', [], [
  { className: 'comment', regex: /\/\/[^\n]*|\/\*[\s\S]*?\*\//g },
  { className: 'string', regex: /"""[\s\S]*?"""|"(?:\\.|[^"\\\n])*"/g },
  { className: 'meta', regex: /@[A-Za-z_]\w*|#(?:available|if|else|endif|selector|keyPath)\b/g },
  { className: 'function', regex: /\bfunc\s+([A-Za-z_]\w*)/g, group: 1 },
  {
    className: 'keyword',
    regex: /\b(?:actor|as|associatedtype|async|await|break|case|catch|class|continue|convenience|default|defer|deinit|do|else|enum|extension|fallthrough|fileprivate|final|for|func|guard|if|import|in|indirect|init|inout|internal|is|lazy|let|mutating|nonmutating|open|operator|private|protocol|public|repeat|required|rethrows|return|self|static|struct|subscript|super|switch|throw|throws|try|typealias|var|weak|where|while)\b/g,
  },
  { className: 'literal', regex: /\b(?:true|false|nil)\b/g },
  {
    className: 'type',
    regex: /\b(?:Any|Array|Bool|Character|Data|Dictionary|Double|Error|Float|Int|Int8|Int16|Int32|Int64|Optional|Result|Set|String|UInt|Void)\b/g,
  },
  { className: 'number', regex: /\b(?:0[xX][\da-fA-F_]+|0[bB][01_]+|\d[\d_]*(?:\.\d[\d_]*)?(?:[eE][+-]?\d+)?)\b/g },
])

const php = patternLanguage('php', [], [
  { className: 'comment', regex: /\/\/[^\n]*|#[^\n]*|\/\*[\s\S]*?\*\//g },
  { className: 'string', regex: /"(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'/g },
  { className: 'meta', regex: /<\?php|<\?=|\?>/g },
  { className: 'function', regex: /\bfunction\s+&?([A-Za-z_]\w*)/g, group: 1 },
  { className: 'variable', regex: /\$\w+/g },
  {
    className: 'keyword',
    regex: /\b(?:abstract|and|array|as|break|callable|case|catch|class|clone|const|continue|declare|default|do|echo|else|elseif|empty|enum|extends|final|finally|fn|for|foreach|function|global|goto|if|implements|include|include_once|instanceof|insteadof|interface|isset|list|match|namespace|new|or|print|private|protected|public|readonly|require|require_once|return|static|switch|throw|trait|try|unset|use|var|while|xor|yield)\b/g,
  },
  { className: 'literal', regex: /\b(?:true|false|null|TRUE|FALSE|NULL)\b/g },
  { className: 'type', regex: /\b(?:bool|float|int|iterable|mixed|object|string|void|self|parent)\b/g },
  { className: 'number', regex: /\b(?:0[xX][\da-fA-F_]+|\d[\d_]*(?:\.\d[\d_]*)?(?:[eE][+-]?\d+)?)\b/g },
])

const LANGUAGES: ReadonlyArray<LanguageDefinition> = [
  plaintext,
  shell,
  python,
  ts,
  tsx,
  js,
  jsx,
  json,
  yaml,
  markdown,
  env,
  css,
  diff,
  dockerfile,
  html,
  http,
  sql,
  toml,
  rust,
  ini,
  csv,
  go,
  java,
  c,
  cpp,
  ruby,
  graphql,
  makefile,
  scss,
  kotlin,
  swift,
  php,
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

/**
 * Highlight a whole file, returning one HTML string per source line.
 *
 * The coding file viewer renders a line-number gutter, so it needs the markup
 * pre-split by line — and unlike splitting a highlighter's output on ``\n``,
 * ``renderTokens`` cuts tokens at line boundaries, so a block comment or
 * triple-quoted string yields balanced markup on every line it covers rather
 * than an unclosed span the browser has to repair.
 *
 * HTML rather than React elements is deliberate here: a 512 kB file would
 * otherwise become tens of thousands of React elements. Token text is escaped
 * by ``renderNodesToHtml``, so injecting the result is safe.
 *
 * The result always has ``content.split('\n').length`` entries: the viewer's
 * gutter numbers have to line up with the file's own line numbers, which
 * selections and ``@``-mentions refer to.
 */
export function highlightLines(code: string, language?: string): Array<string> {
  const { tokens } = highlighter.tokenize(code, { lang: language })
  // ``lineNumbers`` is what switches renderTokens into per-line wrapping; we
  // want the split, not the gutter it implies (the viewer draws its own).
  const lines = renderTokens(tokens, { lineNumbers: true })
    .filter((node) => node.type === 'element')
    .map((node) => renderNodesToHtml(node.children))
  // renderTokens has no line after a final newline; `split` reports one.
  if (code.endsWith('\n')) lines.push('')
  return lines
}
