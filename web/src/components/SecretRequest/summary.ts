/**
 * The transcript lines of a finished secret request, read back from the tool
 * result the agent got (``appv3_agent::secret_request::result_text``). Names
 * only: a result never holds a value.
 */
const PATTERNS: readonly (readonly [RegExp, string])[] = [
  [/The user provided (.+?)\.(?:\s|$)/, 'Provided'],
  [/The user saved new values for (.+?)\.(?:\s|$)/, 'Replaced'],
  [/They chose saved values for (.+?)\.(?:\s|$)/, 'Using saved'],
  [/Already available(?: in this project)?: (.+?)\.(?:\s|$)/, 'Already available'],
  [/Skipped: (.+?)\.(?:\s|$)/, 'Skipped'],
]

export function secretSummaryFromResult(result: string): string[] {
  const text = result.trim()
  if (text.startsWith('The user declined')) return ['Declined']
  const lines = PATTERNS.flatMap(([re, label]) => {
    const m = re.exec(text)
    return m ? [`${label}: ${m[1]}`] : []
  })
  if (lines.length > 0) return lines
  const first = /^[^.\n]*[.\n]?/.exec(text)?.[0]?.trim()
  return first ? [first] : []
}
