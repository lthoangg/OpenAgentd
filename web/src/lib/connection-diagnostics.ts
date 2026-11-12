/**
 * "Copy diagnostics": the phone shell's last connection events
 * (`cloud_diagnostics`, `native/cloud/src/diag.rs`) as plain text, under a
 * header with the app's version and the time. The shell writes every line,
 * so no key, token, id, address or URL can be in it; the page adds only the
 * local times.
 */
export interface DiagnosticsLine {
  /** Unix milliseconds. */
  at_ms: number
  text: string
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const pad = (n: number) => String(n).padStart(2, '0')

function clock(at: Date, seconds: boolean): string {
  const hm = `${pad(at.getHours())}:${pad(at.getMinutes())}`
  return seconds ? `${hm}:${pad(at.getSeconds())}` : hm
}

/** "OpenAgentd 3.53.1 (iOS) · 12 Nov 18:42", then "18:41:07  app back", … */
export function diagnosticsText(lines: DiagnosticsLine[], about: { version: string; platform: string; now: Date }): string {
  const { version, platform, now } = about
  const header = `OpenAgentd ${version} (${platform}) · ${now.getDate()} ${MONTHS[now.getMonth()]} ${clock(now, false)}`
  return [header, ...lines.map((line) => `${clock(new Date(line.at_ms), true)}  ${line.text}`)].join('\n')
}

/** The shell's lines; none from a shell without them. */
export async function loadDiagnostics(): Promise<DiagnosticsLine[]> {
  try {
    const { invoke } = await import('@tauri-apps/api/core')
    const lines = await invoke<DiagnosticsLine[] | null>('cloud_diagnostics')
    return Array.isArray(lines) ? lines : []
  } catch {
    return []
  }
}
