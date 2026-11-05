/**
 * "Add to message" and "Model and thinking" open as phone sheets with two
 * detents: medium, and large when the content is taller than that. Short
 * content just fits (iOS sizes a short sheet to what it holds).
 *
 * happy-dom has no layout: the content's height and the viewport's are
 * stubbed (800px: medium 400px).
 */
import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ReactNode } from 'react'

mock.module('@/hooks/use-mobile', () => ({
  useIsMobile: () => true,
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
const { useUIStore } = await import('@/stores/useUIStore')
type RunSettings = import('@/components/composer/useRunSettings').RunSettings

let contentHeight = 1000
const realOffsetHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetHeight')
const realInnerHeight = Object.getOwnPropertyDescriptor(window, 'innerHeight')

beforeEach(() => {
  contentHeight = 1000
  useUIStore.setState({ runPickerOpen: false, plusMenuOpen: false, plusMenuSection: null })
  Object.defineProperty(window, 'innerHeight', { value: 800, configurable: true, writable: true })
  Object.defineProperty(HTMLElement.prototype, 'offsetHeight', {
    configurable: true,
    get(this: HTMLElement) {
      if (this.hasAttribute('data-sheet-content')) return contentHeight
      if (this.hasAttribute('data-sheet-handle')) return 24
      return 0
    },
  })
})

afterEach(() => {
  cleanup()
  if (realOffsetHeight) Object.defineProperty(HTMLElement.prototype, 'offsetHeight', realOffsetHeight)
  if (realInnerHeight) Object.defineProperty(window, 'innerHeight', realInnerHeight)
})

function wrap(node: ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, enabled: false } } })
  return render(<QueryClientProvider client={client}>{node}</QueryClientProvider>)
}

function runSettings(): RunSettings {
  return {
    agentName: 'code', agentModel: 'anthropic:claude-sonnet-4-5', agentThinkingLevel: null,
    model: 'anthropic:claude-sonnet-4-5', provider: 'anthropic', thinkingLevel: 'high', customized: false,
    thinkingLevels: ['low', 'high'], models: [], modelsLoading: false, providerInfo: undefined,
    accounts: null, credentialId: null, pinnedAccount: null,
  }
}

const actions = { attach: () => {}, startToken: () => {}, setDraft: () => {} }
const sheet = (label: string) => document.querySelector<HTMLElement>(`[data-bottom-sheet][aria-label="${label}"]`)

describe('PlusMenu on a phone', () => {
  it('opens "Add to message" at medium when its content is taller', () => {
    wrap(<PlusMenu actions={actions} workspace="/repo" />)
    fireEvent.click(screen.getByRole('button', { name: 'Add to message' }))
    const opened = sheet('Add to message')!
    expect(opened.dataset.detent).toBe('medium')
    expect(opened.style.height).toBe('400px')
  })

  it('just fits a short menu', () => {
    contentHeight = 220
    wrap(<PlusMenu actions={actions} workspace="/repo" />)
    fireEvent.click(screen.getByRole('button', { name: 'Add to message' }))
    const opened = sheet('Add to message')!
    expect(opened.dataset.detent).toBe('fit')
    expect(opened.style.height).toBe('')
  })

  it('pulls up to large on a wheel step, as a sheet does with a long MCP list', () => {
    wrap(<PlusMenu actions={actions} workspace="/repo" />)
    fireEvent.click(screen.getByRole('button', { name: 'Add to message' }))
    act(() => { fireEvent.wheel(document.querySelector('[data-sheet-body]')!, { deltaY: 80 }) })
    expect(sheet('Add to message')!.dataset.detent).toBe('large')
  })
})

describe('RunChip on a phone', () => {
  it('opens "Model and thinking" at medium when the picker is taller', () => {
    wrap(<RunChip settings={runSettings()} />)
    fireEvent.click(document.querySelector('[data-run-chip]') as HTMLElement)
    const opened = sheet('Model and thinking')!
    expect(opened.dataset.detent).toBe('medium')
    expect(opened.style.height).toBe('400px')
  })

  it('just fits a picker shorter than medium', () => {
    contentHeight = 260
    wrap(<RunChip settings={runSettings()} />)
    fireEvent.click(document.querySelector('[data-run-chip]') as HTMLElement)
    const opened = sheet('Model and thinking')!
    expect(opened.dataset.detent).toBe('fit')
    expect(opened.style.height).toBe('')
  })
})
