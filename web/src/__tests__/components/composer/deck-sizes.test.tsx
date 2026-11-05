/**
 * The run deck (the composer's action row) is one height on each kind of
 * device: 28px on desktop, 36px on any touch screen, phones included (32px
 * in a narrow mouse window). "+", Code/Plan, the model chip, the context ring
 * and Send all take the same steps, and all but Send (a full pill) share the
 * 6px radius. On a phone the controls stay 36px (the composer is compact)
 * and their touch area grows to 44px; the text is a step down too: 15px for
 * the message, 13px on the deck.
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
/** The 32 / 28 / 36 steps, as ``h-*`` or ``size-*``: no larger phone step. */
const steps = (prop: 'h' | 'size') => [`${prop}-8`, `md:${prop}-7`, `pointer-coarse:${prop}-9`]
const noPhoneStep = (el: Element) => classes(el).filter((c) => /^phone:(h|size|min-h)-/.test(c))

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
    mode: screen.getByRole('button', { name: /^Code mode/ }),
    chip: document.querySelector('[data-run-chip]') as HTMLElement,
    context: document.querySelector('[data-context-meter]') as HTMLElement,
  }
}

describe('the run deck is one height per device', () => {
  it('sizes "+" and Send as squares: 28px desktop, 36px on touch, a phone too', () => {
    const { plus } = deck()
    render(<InputComposer onSubmit={() => {}} />)
    const send = screen.getByRole('button', { name: 'Send message' })
    for (const el of [plus, send]) {
      expect(classes(el)).toEqual(expect.arrayContaining(steps('size')))
      expect(noPhoneStep(el)).toEqual([])
    }
  })

  it('gives Code/Plan, the model chip and the context ring the same heights', () => {
    const { mode, chip, context } = deck()
    for (const el of [mode, chip, context]) {
      expect(classes(el)).toEqual(expect.arrayContaining(steps('h')))
      expect(noPhoneStep(el)).toEqual([])
    }
    // Not held at 28px on a touch tablet.
    expect(classes(mode)).not.toContain('max-md:pointer-coarse:h-9')
  })

  it('grows the touch area of every control to 44px on a phone', () => {
    const { plus, mode, chip, context } = deck()
    render(<InputComposer onSubmit={() => {}} />)
    const send = screen.getByRole('button', { name: 'Send message' })
    for (const el of [plus, mode, chip, context, send]) {
      expect(classes(el)).toEqual(expect.arrayContaining(['relative', 'touch-hit']))
    }
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

describe('the phone composer\'s text, a step down', () => {
  it('writes the message at 15px on a phone', () => {
    render(<InputComposer onSubmit={() => {}} />)
    const field = classes(screen.getByLabelText('Message input'))
    expect(field).toContain('phone:text-subhead')
    expect(field).not.toContain('max-md:pointer-coarse:text-base')
  })

  it('labels Code/Plan and the model chip at 13px on a phone', () => {
    const { mode, chip } = deck()
    for (const el of [mode, chip]) {
      expect(classes(el)).toContain('phone:text-meta')
      expect(classes(el)).not.toContain('phone:text-subhead')
    }
  })
})

describe('which step wins', () => {
  const read = (path: string) => readFileSync(fileURLToPath(new URL(path, import.meta.url)), 'utf8')
  const base = fileURLToPath(new URL('../../..', import.meta.url))

  it('puts touch after desktop, so a touch tablet and a phone are 36px', async () => {
    const compiler = await compile(read('../../../index.css'), { base, onDependency() {} })
    const out = compiler.build(['md:h-7', 'pointer-coarse:h-9'])
    const at = (name: string) => out.indexOf(`.${name.replace(':', '\\:')} {`)
    expect(at('md:h-7')).toBeGreaterThan(-1)
    expect(at('pointer-coarse:h-9')).toBeGreaterThan(at('md:h-7'))
  })

  it('holds the deck\'s "+" at 36px on a phone, where other buttons are 44px (48px on Android)', () => {
    const css = read('../../../index.css').replace(/\/\*[\s\S]*?\*\//g, '')
    expect(css).toMatch(/:root \[data-run-deck\] \[data-slot="button"\]\s*\{\s*min-height:\s*36px;\s*min-width:\s*36px;/)
    expect(css).not.toMatch(/\[data-run-deck\] \[data-slot="button"\]\s*\{\s*min-height:\s*44px/)
  })
})
