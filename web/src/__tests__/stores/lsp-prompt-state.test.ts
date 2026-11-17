import { describe, expect, it } from 'bun:test'
import { IllegalTransition } from '@/lib/machine'
import { LSP_NONE, lspAsking, lspPromptMachine, type LspPrompt, type LspPromptEvent } from '@/stores/lsp-prompt-state'

const A = { workspace: '/a', languageServerVersion: '1', typeScriptVersion: '5' }
const B = { workspace: '/b', languageServerVersion: '1', typeScriptVersion: '5' }
const run = (events: LspPromptEvent[], from: LspPrompt = LSP_NONE) => events.reduce(lspPromptMachine.transition, from)

describe('lsp install prompt', () => {
  it('starts no install without a line asking', () => {
    expect(() => lspPromptMachine.transition(LSP_NONE, { type: 'install', request: A })).toThrow(IllegalTransition)
  })

  it('lists every other move', () => {
    expect(lspPromptMachine.moves()).toHaveLength(13)
  })

  it('closes only the line an install was started from', () => {
    const installing = run([{ type: 'request', request: A }, { type: 'install', request: A }])
    expect(run([{ type: 'request', request: B }, { type: 'installed', request: A }], installing)).toEqual(lspAsking(B))
    expect(run([{ type: 'installed', request: A }], installing)).toEqual(LSP_NONE)
  })

  it('keeps an install under way when the server asks again for the same folder', () => {
    const installing = run([{ type: 'request', request: A }, { type: 'install', request: A }])
    expect(run([{ type: 'request', request: { ...A } }], installing)).toBe(installing)
  })

  it('offers Retry after a failure, and keeps it through a repeat request', () => {
    const failed = run([{ type: 'request', request: A }, { type: 'install', request: A }, { type: 'installFailed', request: A }])
    expect(failed).toEqual({ kind: 'asking', request: A, failed: true })
    expect(run([{ type: 'request', request: { ...A } }], failed)).toBe(failed)
  })

  it('dismisses only its own line, or any without a request', () => {
    const asking = lspAsking(A)
    expect(run([{ type: 'dismiss', request: B }], asking)).toBe(asking)
    expect(run([{ type: 'dismiss' }], asking)).toEqual(LSP_NONE)
  })
})
