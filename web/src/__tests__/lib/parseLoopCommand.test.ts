import { describe, expect, it } from 'bun:test'

import { parseLoopCommand } from '@/lib/parseLoopCommand'

describe('parseLoopCommand', () => {
  it('parses root loop prompt as raw text after the space', () => {
    expect(parseLoopCommand('/loop just say hi')).toEqual({ kind: 'start', prompt: 'just say hi' })
  })

  it('reports missing root prompt', () => {
    expect(parseLoopCommand('/loop')).toEqual({ kind: 'start_missing_prompt' })
  })

  it('parses supported loop limits', () => {
    expect(parseLoopCommand('/loop:set 20')).toEqual({ kind: 'set', limit: 20 })
  })

  it('rejects unsupported loop limits', () => {
    expect(parseLoopCommand('/loop:set 7')).toEqual({ kind: 'set_invalid_limit' })
  })

  it('rejects set commands with extra text', () => {
    expect(parseLoopCommand('/loop:set 10 now')).toEqual({ kind: 'set_invalid_limit' })
  })

  it('parses no-arg loop controls', () => {
    expect(parseLoopCommand('/loop:pause')).toEqual({ kind: 'pause' })
    expect(parseLoopCommand('/loop:resume')).toEqual({ kind: 'resume' })
    expect(parseLoopCommand('/loop:stop')).toEqual({ kind: 'stop' })
  })

  it('does not claim unrelated slash text', () => {
    expect(parseLoopCommand('/oad:debug')).toEqual({ kind: 'none' })
  })

  it('falls through on unknown loop subcommands', () => {
    expect(parseLoopCommand('/loop:status')).toEqual({
      kind: 'unknown_subcommand',
      subcommand: 'status',
    })
  })
})
