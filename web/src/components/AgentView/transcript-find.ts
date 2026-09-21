import type { ContentBlock } from '@/api/types'

export interface TranscriptFindMatch {
  blockId: string
  start: number
  end: number
}

const TRANSCRIPT_FIND_BLOCK_TYPES = new Set<ContentBlock['type']>([
  'user',
  'text',
  'thinking',
])

export function collectTranscriptFindMatches(
  blocks: ContentBlock[],
  rawQuery: string,
): TranscriptFindMatch[] {
  const query = rawQuery.trim()
  if (!query) return []
  const needle = query.toLowerCase()
  const matches: TranscriptFindMatch[] = []
  for (const block of blocks) {
    if (!TRANSCRIPT_FIND_BLOCK_TYPES.has(block.type)) continue
    const haystack = block.content
    if (!haystack) continue
    const lower = haystack.toLowerCase()
    let from = 0
    while (from <= lower.length - needle.length) {
      const start = lower.indexOf(needle, from)
      if (start < 0) break
      matches.push({ blockId: block.id, start, end: start + needle.length })
      from = start + needle.length
    }
  }
  return matches
}

export function isTranscriptFindableBlock(type: ContentBlock['type']): boolean {
  return TRANSCRIPT_FIND_BLOCK_TYPES.has(type)
}
