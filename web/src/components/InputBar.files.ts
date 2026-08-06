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
 * Ceiling on the combined size of one message's attachments.
 *
 * Mirrors ``GLOBAL_SIZE_LIMIT`` in ``app/services/agent_service.py`` — the
 * binding constraint on uploads, and below the request-body envelope in
 * ``app/core/middlewares.py``. Catching it here keeps the rejection in the
 * composer, where the draft and its attachments are still recoverable.
 *
 * Deliberately mirrors only the *global* limit, not the per-category ones —
 * those depend on the backend's explicit MIME→category table, and a frontend
 * guess that rejected a file the server would have accepted is worse than
 * letting the server answer with its precise message.
 *
 * Keep in sync with the backend constant.
 */
export const MAX_TOTAL_ATTACHMENT_BYTES = 50 * 1024 * 1024

/**
 * Split *incoming* files into the ones that still fit alongside *existing*
 * attachments and the ones that would push the request over the limit.
 *
 * Oversize files are skipped individually rather than failing the whole
 * batch, so dropping a folder's worth of screenshots plus one huge video
 * still attaches the screenshots.
 */
export function splitFilesByBudget(
  existing: File[],
  incoming: File[],
): { accepted: File[]; rejected: File[] } {
  let used = existing.reduce((total, file) => total + file.size, 0)
  const accepted: File[] = []
  const rejected: File[] = []

  for (const file of incoming) {
    if (used + file.size > MAX_TOTAL_ATTACHMENT_BYTES) {
      rejected.push(file)
      continue
    }
    used += file.size
    accepted.push(file)
  }

  return { accepted, rejected }
}

/**
 * Extract the real files out of a drop's ``DataTransfer``.
 *
 * ``dataTransfer.files`` alone is not enough: a dropped *folder* shows up
 * there as a zero-byte, type-less ``File``, which would otherwise render an
 * attachment chip and upload as an empty file. ``webkitGetAsEntry()`` is the
 * only reliable way to tell a directory from a genuinely empty file, and it
 * must be called synchronously inside the drop handler before the item list
 * is neutered.
 *
 * Falls back to ``dataTransfer.files`` wherever the entry API is missing, so
 * a browser without it keeps working rather than silently dropping uploads.
 */
export function filesFromDataTransfer(dt: DataTransfer | null): File[] {
  if (!dt) return []

  const items = dt.items
  if (items && items.length > 0) {
    const collected: File[] = []
    let sawDirectory = false

    for (let i = 0; i < items.length; i++) {
      const item = items[i]
      if (item.kind !== 'file') continue

      const entry =
        typeof item.webkitGetAsEntry === 'function' ? item.webkitGetAsEntry() : null
      if (entry?.isDirectory) {
        sawDirectory = true
        continue
      }

      const file = item.getAsFile()
      if (file) collected.push(file)
    }

    // Only trust an empty result when we positively identified a directory —
    // otherwise the item list told us nothing useful and the files list is
    // the better source.
    if (collected.length > 0 || sawDirectory) return collected
  }

  return dt.files ? Array.from(dt.files) : []
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
