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
 * ``LEGACY`` counts writes to the flags that machines are replacing. The
 * counts are exact, so removing a write means lowering its count, and the
 * list only shrinks; it is deleted once empty.
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

export const MACHINES: Record<string, MachineEntry> = {}

/** Old flags a machine replaces: an exact count of writes per file. */
const LEGACY: Record<string, { pattern: RegExp; under: string; allow: Record<string, number> }> = {
  'lead-run isAgentWorking': {
    pattern: /(?<![\w.])\w+\.isAgentWorking\s*=(?![=>])|\bisAgentWorking:\s*(?:true|false)\b/g,
    under: 'stores/',
    allow: {
      'stores/useAgentStore/history-slice.ts': 1,
      'stores/useAgentStore/load-session.ts': 2,
      'stores/useAgentStore/pending-slice.ts': 3,
      'stores/useAgentStore/session-slice.ts': 2,
      'stores/useAgentStore/sse-agent-status.ts': 6,
      'stores/useAgentStore/sse-turn.ts': 2,
      'stores/useAgentStore/stream-slice.ts': 4,
    },
  },
  'lead-run stream status': {
    pattern: /\.status\s*=\s*'(?:idle|working|waiting_input|waiting_lead|offline|error)'/g,
    under: 'stores/useAgentStore/',
    allow: {
      'stores/useAgentStore/helpers.ts': 1,
      'stores/useAgentStore/load-session.ts': 1,
      'stores/useAgentStore/pending-slice.ts': 1,
      'stores/useAgentStore/session-slice.ts': 2,
      'stores/useAgentStore/sse-agent-status.ts': 8,
      'stores/useAgentStore/sse-turn.ts': 2,
      'stores/useAgentStore/stream-slice.ts': 1,
    },
  },
  'lead-run _runningPatchedFor': {
    pattern: /\._runningPatchedFor\s*=(?![=>])/g,
    under: 'stores/',
    allow: {
      'stores/useAgentStore/load-session.ts': 2,
      'stores/useAgentStore/pending-slice.ts': 1,
      'stores/useAgentStore/session-slice.ts': 1,
      'stores/useAgentStore/sse-agent-status.ts': 2,
      'stores/useAgentStore/sse-turn.ts': 1,
      'stores/useAgentStore/stream-slice.ts': 2,
    },
  },
  'question pendingQuestion': {
    pattern: /\.pendingQuestion\s*=(?![=>])/g,
    under: 'stores/',
    allow: {
      'stores/useAgentStore/helpers.ts': 1,
      'stores/useAgentStore/load-session.ts': 1,
      'stores/useAgentStore/session-slice.ts': 1,
      'stores/useAgentStore/sse-questions.ts': 1,
    },
  },
  'link isConnected': {
    pattern: /(?<![\w.])\w+\.isConnected\s*=(?![=>])|\bisConnected:\s*(?:true|false)\b/g,
    under: 'stores/',
    allow: {
      'stores/useAgentStore/session-slice.ts': 1,
      'stores/useAgentStore/stream-slice.ts': 8,
    },
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
        const write = new RegExp(`(?<![\\w.])(?:\\w+\\.)?${field}\\s*(?:=(?![=>])|:(?!:))\\s*(?![\\w.]*\\.transition\\()`, 'g')
        for (const { rel, text } of FILES) {
          if (machine.initial.includes(rel)) continue
          for (const line of text.split('\n')) {
            const trimmed = line.trim()
            if (/^(?:\*|\/\/|\/\*)/.test(trimmed)) continue
            // A type member (``field: LeadRun``) declares it, not a write.
            if (new RegExp(`^(?:readonly\\s+)?${field}\\??:\\s*[A-Z]`).test(trimmed)) continue
            if (write.test(line)) offenders.push(`${rel}: ${trimmed}`)
            write.lastIndex = 0
          }
        }
      }
      expect(offenders).toEqual([])
    })
  }

  for (const [name, legacy] of Object.entries(LEGACY)) {
    it(`${name}: no new writes to a flag a machine replaces`, () => {
      expect(count(legacy.pattern, legacy.under)).toEqual(legacy.allow)
    })
  }
})
