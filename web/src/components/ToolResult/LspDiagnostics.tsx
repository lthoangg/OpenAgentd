/**
 * The LSP diagnostics an edit result carries after its `[LSP Diagnostics]`
 * marker: parsed off the result text and shown as error and warning lines
 * under it. The tool result and the diff view both show them.
 */

export interface LspDiagnosticItem {
  filePath: string
  line: number
  character: number
  severity: 'error' | 'warning'
  message: string
  source: string
}

export function parseLspDiagnostics(text: string): {
  cleanText: string
  diagnostics: LspDiagnosticItem[]
  /** Number of additional diagnostics omitted by the backend cap, if any. */
  overflowCount: number
} | null {
  const marker = '[LSP Diagnostics]\n'
  const idx = text.indexOf(marker)
  if (idx === -1) return null

  const cleanText = text.slice(0, idx).trim()
  const diagnosticsPart = text.slice(idx + marker.length)

  const diagnostics: LspDiagnosticItem[] = []
  let overflowCount = 0
  const lines = diagnosticsPart.split('\n')
  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed.startsWith('- ')) continue

    // Backend cap summary line: "- …and 12 more in path/to/file.py"
    const moreMatch = trimmed.match(/^-\s+…and\s+(\d+)\s+more\b/)
    if (moreMatch) {
      overflowCount += parseInt(moreMatch[1], 10)
      continue
    }

    // Parse: - path/to/file.py:line:col: severity: Message (source)
    const match = trimmed.match(/^-\s+(.*?):(\d+):(\d+):\s+(error|warning):\s+(.*?)\s*\((.*?)\)$/)
    if (match) {
      diagnostics.push({
        filePath: match[1],
        line: parseInt(match[2], 10),
        character: parseInt(match[3], 10),
        severity: match[4] as 'error' | 'warning',
        message: match[5],
        source: match[6]
      })
    }
  }

  if (diagnostics.length === 0) return null
  return { cleanText, diagnostics, overflowCount }
}

export function LspDiagnosticsView({
  diagnostics,
  overflowCount = 0,
}: {
  diagnostics: LspDiagnosticItem[]
  overflowCount?: number
}) {
  if (diagnostics.length === 0) return null

  return (
    // Only error lines get a tint; a warning is not an error.
    <div className="flex flex-col border-t border-(--color-border) py-1">
      {diagnostics.map((d, i) => {
        const isError = d.severity === 'error'
        const label = isError ? 'Error' : 'Warning'
        const labelColor = isError ? 'text-(--color-error)' : 'text-(--accent-orange-text)'
        const locationColor = 'text-(--color-text-muted)'

        return (
          <div key={i} className={`flex items-baseline gap-1.5 px-2.5 font-mono text-xs leading-tight ${isError ? 'bg-(--color-error-subtle)' : ''}`}>
            <span className={`${labelColor} shrink-0 font-sans font-medium`}>
              {label}
            </span>
            <span className={`${locationColor} shrink-0`}>
              {d.line}:{d.character}
            </span>
            <span className="break-words text-(--color-text)">
              {d.message}
            </span>
          </div>
        )
      })}
      {overflowCount > 0 && (
        <div className="font-mono text-xs md:text-meta leading-tight text-(--color-text-muted) italic">
          +{overflowCount} more
        </div>
      )}
    </div>
  )
}
