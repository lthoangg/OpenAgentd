import type { AgentCapabilities } from '@/api/types'

/**
 * The `accept` attribute for the hidden file input. This guides the OS file
 * picker but does NOT enforce a hard block — `isFileTypeAllowed` returns true
 * for every file so paste, drag-and-drop, and picker uploads all work with
 * any file type. The list here is broad enough to avoid a confusing picker
 * experience while still covering every type the agent can handle.
 */
export function buildAcceptString(_capabilities?: AgentCapabilities): string {
  const parts: string[] = [
    // Plain text / markup / config
    'text/plain', 'text/csv', 'text/tab-separated-values', 'text/markdown',
    'text/html', 'text/css', 'text/javascript', 'text/typescript',
    '.txt', '.csv', '.tsv', '.md', '.mdx', '.html', '.css', '.js', '.mjs',
    '.cjs', '.ts', '.tsx', '.jsx',
    // Data / config
    'application/json', 'application/x-yaml', 'application/toml',
    '.json', '.yaml', '.yml', '.toml', '.env', '.ini', '.conf',
    // Source code (no standard MIME — extension only)
    '.py', '.go', '.rs', '.rb', '.java', '.kt', '.swift', '.c', '.cpp',
    '.h', '.hpp', '.cs', '.php', '.sh', '.bash', '.zsh', '.fish',
    '.sql', '.graphql', '.proto', '.xml', '.tf', '.tfvars',
    // Documents
    'application/pdf',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    '.pdf', '.docx', '.xlsx', '.pptx',
    // Media
    'image/*',
    'audio/*',
    'video/*',
  ]
  return parts.join(',')
}

/**
 * Every file the user explicitly attaches — via paste, drag-and-drop, or the
 * file picker — is allowed. The agent backend decides what it can do with a
 * given file; the frontend should not silently discard attachments.
 */
export function isFileTypeAllowed(
  _file: File,
  _capabilities?: AgentCapabilities,
): boolean {
  return true
}
