import type { AgentCapabilities } from '@/api/types'

export function buildAcceptString(_capabilities?: AgentCapabilities): string {
  const parts: string[] = [
    'text/plain', 'text/csv', 'text/tab-separated-values', 'text/markdown',
    'application/json', '.txt', '.csv', '.tsv', '.json', '.md',
    'image/*',
    'application/pdf',
    '.pdf',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    '.docx',
    'audio/*',
    'video/*',
  ]
  return parts.join(',')
}

export function isFileTypeAllowed(
  file: File,
  _capabilities?: AgentCapabilities,
): boolean {
  const mimeType = file.type
  const name = file.name.toLowerCase()
  if (
    mimeType.startsWith('text/') || mimeType === 'application/json' ||
    name.endsWith('.txt') || name.endsWith('.csv') || name.endsWith('.tsv') ||
    name.endsWith('.json') || name.endsWith('.md')
  ) return true
  if (mimeType.startsWith('image/')) return true
  if (
    mimeType === 'application/pdf' ||
    mimeType === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' ||
    name.endsWith('.pdf') || name.endsWith('.docx')
  ) return true
  if (mimeType.startsWith('audio/')) return true
  if (mimeType.startsWith('video/')) return true
  return false
}
