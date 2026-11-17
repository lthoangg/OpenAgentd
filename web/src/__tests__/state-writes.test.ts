/**
 * State machines guard (``web/src/AGENTS.md`` → State machines). A
 * lifecycle lives in one state field and changes only through its machine's
 * ``transition`` (``lib/machine.ts``); flags such as "working" or "connected"
 * are derived from it with a selector, never stored beside it.
 *
 * ``MACHINES`` lists every machine: the file that defines it and the store
 * fields that hold its state. A ``defineMachine(`` in a file not listed here
 * fails, so a new machine is registered here first. A write to a listed
 * field that is not ``<machine>.transition(…)`` fails too (``initial`` names
 * the files that may set the first value).
 *
 * ``SINGLE_WRITER`` names data a machine reads that has one writer (an
 * agent's status, set only by ``setAgentStatus``).
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
    return /\.(ts|tsx)$/.test(name) ? [path] : []
  })
}

const FILES = sourceFiles(SRC).map((path) => ({ rel: relative(SRC, path), text: readFileSync(path, 'utf8') }))

interface MachineEntry {
  /** The file whose ``defineMachine`` call makes it. */
  file: string
  /** Store fields that hold its state. */
  fields: string[]
  /** Files that may write a field's first value (defaults, a reset). */
  initial: string[]
}

export const MACHINES: Record<string, MachineEntry> = {
  'session run': {
    file: 'stores/useAgentStore/run-state.ts',
    fields: ['sessionRun'],
    initial: ['stores/useAgentStore/stream-slice.ts'],
  },
  'question card': {
    file: 'stores/useAgentStore/question-state.ts',
    fields: ['questionCard'],
    initial: ['stores/useAgentStore/stream-slice.ts'],
  },
  'session link': {
    file: 'stores/useAgentStore/link-state.ts',
    fields: ['streamLink'],
    initial: ['stores/useAgentStore/stream-slice.ts'],
  },
}

/**
 * Fields with one writer: data a machine reads, set only through the named
 * function in the named file. An agent's status mirrors the backend's member
 * state, so any status may follow any other, but it is still written in one
 * place, beside the session run it feeds.
 */
const SINGLE_WRITER: Record<string, { pattern: RegExp; under: string; file: string }> = {
  'agent status (setAgentStatus)': {
    pattern: /\.status\s*=(?![=>])/g,
    under: 'stores/useAgentStore/',
    file: 'stores/useAgentStore/run-state.ts',
  },
}

function count(pattern: RegExp, under: string): Record<string, number> {
  const counts: Record<string, number> = {}
  for (const { rel, text } of FILES) {
    if (!rel.startsWith(under)) continue
    const n = text.match(pattern)?.length ?? 0
    if (n) counts[rel] = n
  }
  return counts
}

describe('state machines', () => {
  it('every defineMachine is registered in MACHINES', () => {
    const defining = FILES.filter(({ rel, text }) => rel !== 'lib/machine.ts' && /\bdefineMachine\s*[<(]/.test(text)).map(({ rel }) => rel)
    expect(defining.sort()).toEqual(Object.values(MACHINES).map((m) => m.file).sort())
  })

  for (const [name, machine] of Object.entries(MACHINES)) {
    it(`${name}: its state changes only through transition`, () => {
      const offenders: string[] = []
      for (const field of machine.fields) {
        // ``field = x`` or ``field: x`` (in a set/patch object), unless x is a transition.
        const write = new RegExp(`(?<![\\w.])(?:\\w+\\.)?${field}\\s*(?:=(?![=>])|:(?!:))(?!\\s*[\\w.]*\\.transition\\()`, 'g')
        for (const { rel, text } of FILES) {
          if (machine.initial.includes(rel)) continue
          for (const line of text.split('\n')) {
            const trimmed = line.trim()
            if (/^(?:\*|\/\/|\/\*)/.test(trimmed)) continue
            // A type member (``field: SessionRun``) declares it, not a write.
            if (new RegExp(`^(?:readonly\\s+)?${field}\\??:\\s*[A-Z]`).test(trimmed)) continue
            if (write.test(line)) offenders.push(`${rel}: ${trimmed}`)
            write.lastIndex = 0
          }
        }
      }
      expect(offenders).toEqual([])
    })
  }

  for (const [name, rule] of Object.entries(SINGLE_WRITER)) {
    it(`${name}: written only in ${rule.file}`, () => {
      expect(Object.keys(count(rule.pattern, rule.under))).toEqual([rule.file])
    })
  }
})
