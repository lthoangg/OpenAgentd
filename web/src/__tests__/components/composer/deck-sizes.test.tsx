/**
 * The run deck (the composer's action row) is one height on each kind of
 * device: 28px on desktop, 36px on a touch tablet, 44px on a phone (32px in a
 * narrow mouse window). "+", Code/Plan, the model chip, the context ring and
 * Send all take the same steps, and all but Send (a full pill) share the 6px
 * radius.
 *
 * happy-dom has no layout or media queries: the size classes are the
 * contract, and the compiled stylesheet shows which step wins where.
 */
import { afterEach, describe, expect, it, mock } from 'bun:test'
import { cleanup, render, screen } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { compile } from '@tailwindcss/node'
import type { ReactNode } from 'react'

mock.module('@/hooks/use-mobile', () => ({
  useIsMobile: () => false,
  MOBILE_QUERY: '(max-width: 767px), (max-height: 580px)',
}))
mock.module('@/queries/useAgentsQuery', () => ({
  useAgentsQuery: () => ({ data: { agents: [{ name: 'code', mcp_servers: [], tools: [] }] }, refetch: async () => {} }),
}))
mock.module('@/queries/useMcpQuery', () => ({
  useMcpServersQuery: () => ({ data: { servers: [] }, isLoading: false, isError: false, refetch: async () => {} }),
  useUpdateMcpServerMutation: () => ({ mutate: () => {}, isPending: false }),
  useConnectMcpOAuthMutation: () => ({ mutate: () => {}, isPending: false }),
}))

const { RunChip } = await import('@/components/composer/RunChip')
const { PlusMenu } = await import('@/components/composer/PlusMenu')
const { ContextMeter } = await import('@/components/composer/ContextMeter')
const { SessionModeToggle } = await import('@/components/SessionModeToggle')
const { InputComposer } = await import('@/components/InputComposer')
type RunSettings = import('@/components/composer/useRunSettings').RunSettings

afterEach(cleanup)

function wrap(node: ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, enabled: false } } })
  return render(<QueryClientProvider client={client}>{node}</QueryClientProvider>)
}

const settings: RunSettings = {
  agentName: 'code', agentModel: 'anthropic:claude-sonnet-4-5', agentThinkingLevel: null,
  model: 'anthropic:claude-sonnet-4-5', provider: 'anthropic', thinkingLevel: 'high', customized: false,
  thinkingLevels: ['low', 'high'], models: [], modelsLoading: false, providerInfo: undefined,
  accounts: null, credentialId: null, pinnedAccount: null,
}

const classes = (el: Element) => el.className.toString().split(/\s+/)
/** The 32 / 28 / 36 / 44 steps, as ``h-*`` or ``size-*``. */
const steps = (prop: 'h' | 'size') => [`${prop}-8`, `md:${prop}-7`, `pointer-coarse:${prop}-9`, `phone:${prop}-11`]

function deck() {
  wrap(
    <div>
      <PlusMenu actions={{ attach: () => {}, startToken: () => {}, setDraft: () => {} }} workspace="/repo" />
      <SessionModeToggle mode="code" onChange={() => {}} />
      <RunChip settings={settings} />
      <ContextMeter input={1000} output={10} trigger={50000} canSummarize />
    </div>,
  )
  return {
    plus: screen.getByRole('button', { name: 'Add to message' }),
    mode: screen.getByRole('group', { name: 'Interaction mode' }),
    chip: document.querySelector('[data-run-chip]') as HTMLElement,
    context: document.querySelector('[data-context-meter]') as HTMLElement,
  }
}

describe('the run deck is one height per device', () => {
  it('sizes "+" and Send as squares: 28px desktop, 36px touch tablet, 44px phone', () => {
    const { plus } = deck()
    render(<InputComposer onSubmit={() => {}} />)
    const send = screen.getByRole('button', { name: 'Send message' })
    for (const el of [plus, send]) expect(classes(el)).toEqual(expect.arrayContaining(steps('size')))
  })

  it('gives Code/Plan, the model chip and the context ring the same heights', () => {
    const { mode, chip, context } = deck()
    for (const el of [mode, chip, context]) expect(classes(el)).toEqual(expect.arrayContaining(steps('h')))
    // Not held at 28px on a touch tablet any more.
    expect(classes(mode)).not.toContain('max-md:pointer-coarse:h-9')
  })

  it('rounds every control 6px but Send, which stays a full pill', () => {
    const { plus, mode, chip, context } = deck()
    for (const el of [plus, mode, chip, context]) {
      expect(classes(el)).toContain('rounded-sm')
      expect(classes(el)).not.toContain('rounded-md')
    }
    render(<InputComposer onSubmit={() => {}} />)
    expect(classes(screen.getByRole('button', { name: 'Send message' }))).toContain('rounded-full')
  })

  it('keeps the context ring 36px wide on a phone, so a 320px screen is no tighter', () => {
    const { context } = deck()
    expect(classes(context)).toContain('pointer-coarse:min-w-9')
    expect(classes(context).some((c) => /^phone:(min-)?w-/.test(c))).toBe(false)
  })
})

describe('which step wins', () => {
  const read = (path: string) => readFileSync(fileURLToPath(new URL(path, import.meta.url)), 'utf8')
  const base = fileURLToPath(new URL('../../..', import.meta.url))

  it('puts phone after touch after desktop, so a touch tablet is 36px and a phone 44px', async () => {
    const compiler = await compile(read('../../../index.css'), { base, onDependency() {} })
    const out = compiler.build(['md:h-7', 'pointer-coarse:h-9', 'phone:h-11'])
    const at = (name: string) => out.indexOf(`.${name.replace(':', '\\:')} {`)
    expect(at('md:h-7')).toBeGreaterThan(-1)
    expect(at('pointer-coarse:h-9')).toBeGreaterThan(at('md:h-7'))
    expect(at('phone:h-11')).toBeGreaterThan(at('pointer-coarse:h-9'))
  })

  it('holds the deck\'s "+" at 44px in the Android app, where other buttons are 48px', () => {
    const css = read('../../../index.css').replace(/\/\*[\s\S]*?\*\//g, '')
    expect(css).toMatch(/html\[data-mobile-shell="android"\] \[data-run-deck\] \[data-slot="button"\]\s*\{\s*min-height:\s*44px;\s*min-width:\s*44px;/)
  })
})
