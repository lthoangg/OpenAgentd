import { describe, expect, it } from 'bun:test'
import type { ContentBlock } from '@/api/types'
import { collectTranscriptFindMatches } from '@/components/AgentView/transcript-find'

function user(id: string, content: string): ContentBlock {
  return { id, type: 'user', content }
}

function text(id: string, content: string): ContentBlock {
  return { id, type: 'text', content }
}

function thinking(id: string, content: string): ContentBlock {
  return { id, type: 'thinking', content }
}

function tool(id: string): ContentBlock {
  return { id, type: 'tool', content: '', toolName: 'read', toolArgs: 'secret-token', toolResult: 'secret-token' }
}

describe('collectTranscriptFindMatches', () => {
  it('returns nothing for a blank query', () => {
    expect(collectTranscriptFindMatches([user('u1', 'hello')], '   ')).toEqual([])
  })

  it('matches user, assistant, and thinking text, case-insensitively, and skips tools', () => {
    const matches = collectTranscriptFindMatches(
      [
        user('u1', 'Hello world'),
        thinking('th1', 'hello hidden'),
        tool('t1'),
        text('a1', 'Say hello again'),
      ],
      'HELLO',
    )
    expect(matches.map((match) => match.blockId)).toEqual(['u1', 'th1', 'a1'])
  })

  it('records every occurrence inside a block', () => {
    const matches = collectTranscriptFindMatches([text('a1', 'foo foo bar foo')], 'foo')
    expect(matches).toHaveLength(3)
    expect(matches.every((match) => match.blockId === 'a1')).toBe(true)
  })
})
