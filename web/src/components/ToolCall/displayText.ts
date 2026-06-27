const DISPLAY_MAX_CHARS = 12_000
const DISPLAY_HEAD_CHARS = 6_000
const DISPLAY_TAIL_CHARS = 4_000

export function byteLength(text: string): number {
  return new TextEncoder().encode(text).length
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

export function lineCount(text: string): number {
  if (!text) return 0
  return text.split('\n').length
}

export function summarizeText(label: string, text: string | null): string {
  if (!text) return `${label}: empty`
  return `${label}: ${lineCount(text).toLocaleString()} lines · ${formatBytes(byteLength(text))}`
}

export function truncateForDisplay(text: string, maxChars = DISPLAY_MAX_CHARS): string {
  if (text.length <= maxChars) return text
  const omitted = text.length - DISPLAY_HEAD_CHARS - DISPLAY_TAIL_CHARS
  return `${text.slice(0, DISPLAY_HEAD_CHARS)}\n\n... display truncated (${omitted.toLocaleString()} chars omitted) ...\n\n${text.slice(-DISPLAY_TAIL_CHARS)}`
}

export function parsePartialJSON(jsonStr: string): Record<string, unknown> {
  const trimmed = jsonStr.trim()
  if (!trimmed) return {}

  // Try parsing the original string first
  try {
    const parsed = JSON.parse(trimmed)
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>
    }
  } catch {
    // Ignore error, continue to repair
  }

  let repaired = trimmed
  // 1. Repair unclosed string literals
  // Count unescaped double quotes
  let inQuote = false
  for (let i = 0; i < repaired.length; i++) {
    if (repaired[i] === '"' && (i === 0 || repaired[i - 1] !== '\\')) {
      inQuote = !inQuote
    }
  }
  if (inQuote) {
    repaired += '"'
  }

  // 2. Repair unclosed braces/brackets
  let openBraces = 0
  let openBrackets = 0
  inQuote = false
  for (let i = 0; i < repaired.length; i++) {
    if (repaired[i] === '"' && (i === 0 || repaired[i - 1] !== '\\')) {
      inQuote = !inQuote
    }
    if (!inQuote) {
      if (repaired[i] === '{') openBraces++
      else if (repaired[i] === '}') openBraces = Math.max(0, openBraces - 1)
      else if (repaired[i] === '[') openBrackets++
      else if (repaired[i] === ']') openBrackets = Math.max(0, openBrackets - 1)
    }
  }

  // If the repaired string ends with a comma (e.g. `{"path": "foo",`), remove it first before closing
  if (!inQuote) {
    repaired = repaired.trim()
    if (repaired.endsWith(',')) {
      repaired = repaired.slice(0, -1).trim()
    }
  }

  repaired += ']'.repeat(openBrackets)
  repaired += '}'.repeat(openBraces)

  try {
    const parsed = JSON.parse(repaired)
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>
    }
  } catch {
    // Fallback to regex extraction if JSON.parse still fails (e.g. due to newlines)
  }

  const result: Record<string, unknown> = {}
  // Extract all closed string key-value pairs
  const matches = jsonStr.matchAll(/"([^"]+)"\s*:\s*"([^"\\]*(?:\\.[^"\\]*)*)"/g)
  for (const match of matches) {
    result[match[1]] = match[2]
  }
  // Also try to extract trailing unclosed string key-value pairs
  // e.g. `"path": "src/components/ToolResult.tsx` (unclosed double quote)
  const trailingStrMatch = jsonStr.match(/"([^"]+)"\s*:\s*"([^"\\]*(?:\\.[^"\\]*)*)$/)
  if (trailingStrMatch) {
    result[trailingStrMatch[1]] = trailingStrMatch[2]
  }

  return result
}
