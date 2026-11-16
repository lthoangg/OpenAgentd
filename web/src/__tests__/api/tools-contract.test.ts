/**
 * The web client against the backend's list of built-in tools
 * (`appv3/crates/agent/data/tools.json`, which a backend test holds to
 * `tool_registry.rs`). A tool added to the backend alone would reach the
 * transcript as a bare name with raw arguments; a renamed tool would stop
 * matching the rows of old sessions.
 */
import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { canonicalToolName, isPlanSubmission } from '@/utils/tool-names'

const contract = JSON.parse(
  readFileSync(fileURLToPath(new URL('../../../../appv3/crates/agent/data/tools.json', import.meta.url)), 'utf8'),
) as { tools: string[]; former_names: Record<string, string>; retired: string[] }

const source = (rel: string) => readFileSync(fileURLToPath(new URL(`../../${rel}`, import.meta.url)), 'utf8')

/** Tools whose call is drawn by a card of its own, not by a row header. */
const OWN_CARD: Record<string, string> = {
  ask_user: 'components/AskUser',
  update_goal: 'components/GoalClaimCard.tsx',
}

describe('built-in tools', () => {
  const display = source('components/ToolCall/display.tsx')

  it('gives every backend tool a row header or a card of its own', () => {
    const missing = contract.tools.filter((tool) => !(tool in OWN_CARD) && !display.includes(`name === '${tool}'`))
    // Add a `name === '<tool>'` branch to ToolCall/display.tsx, or name the
    // tool's card in OWN_CARD above.
    expect(missing).toEqual([])
    expect(contract.tools.length).toBeGreaterThanOrEqual(20)
  })

  it('keeps no card entry for a tool the backend dropped', () => {
    expect(Object.keys(OWN_CARD).filter((tool) => !contract.tools.includes(tool))).toEqual([])
  })

  it('reads a former name as the tool it became', () => {
    for (const [former, current] of Object.entries(contract.former_names)) {
      // `submit_plan` became `plan` with `submit: true`, so it has its own test.
      if (former === 'submit_plan') expect(isPlanSubmission(former, undefined)).toBe(true)
      // Add the pair to FORMER_TOOL_NAMES in utils/tool-names.ts.
      else expect([former, canonicalToolName(former)]).toEqual([former, current])
    }
  })

  it('still draws the rows of a retired tool in old sessions', () => {
    expect(contract.retired.filter((tool) => !display.includes(`name === '${tool}'`))).toEqual([])
  })
})
