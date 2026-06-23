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
