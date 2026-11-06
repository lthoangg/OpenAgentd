/**
 * On a phone side questions open in a half-height sheet (mockup J5).
 */
import '@testing-library/jest-dom'
import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import { act, cleanup, render, screen } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

mock.module('@/hooks/use-is-phone', () => ({ useIsPhone: () => true }))

const { setApiBaseUrl } = await import('@/api/base-url')
const { BtwPanel } = await import('@/components/BtwPanel')
const { useBtwStore } = await import('@/stores/useBtwStore')

const originalFetch = globalThis.fetch

beforeEach(() => {
  setApiBaseUrl('')
  useBtwStore.setState({ sessions: {} })
  globalThis.fetch = mock(async () => Response.json({ items: [], total: 0 })) as unknown as typeof fetch
})

afterEach(() => {
  cleanup()
  globalThis.fetch = originalFetch
})

describe('BtwPanel on a phone', () => {
  it('shows the side questions in a sheet', async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    render(<QueryClientProvider client={client}><BtwPanel sessionId="s1" countEnabled /></QueryClientProvider>)
    act(() => useBtwStore.getState().reopen('s1'))
    const sheet = await screen.findByRole('dialog', { name: 'Side questions' })
    expect(sheet.querySelector('[data-btw-sheet]')).not.toBeNull()
    expect(sheet.getAttribute('data-bottom-sheet')).not.toBeNull()
  })
})
