/**
 * Touch Servers rows: a tap on the name opens the row, one button per row, Edit and Remove in the row's
 * action sheet, opened by ⋯ or a long press (with one medium haptic).
 */
import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import '@testing-library/jest-dom'

const haptics: string[] = []
const calls: string[] = []
const realHaptics = await import('@/lib/haptics')
mock.module('@/lib/haptics', () => ({ ...realHaptics, mediumHapticFeedback: () => { haptics.push('medium') } }))
mock.module('@/hooks/use-touch-first', () => ({ useTouchFirst: () => true }))

const status = {
  base_url: 'http://127.0.0.1:5999',
  mode: 'external',
  sidecar_running: false,
  external: true,
  supports_bundled: false,
  servers: [{ base_url: 'http://127.0.0.1:4082', name: 'Local CLI' }],
}
mock.module('@tauri-apps/api/core', () => ({
  invoke: async (command: string) => {
    calls.push(command)
    if (command === 'app_backend_status') return status
    if (command === 'app_server_watch_states') return {}
    return null
  },
}))

import { AppBackendPanel } from '@/components/AppBackendPanel'

const originalFetch = globalThis.fetch
beforeEach(() => {
  haptics.length = 0
  calls.length = 0
  window.__OAD_API_BASE_URL__ = 'http://127.0.0.1:5999'
  globalThis.fetch = ((input: RequestInfo | URL) => { calls.push(String(input)); return Promise.resolve(new Response(null, { status: 503 })) }) as typeof fetch
})
afterEach(() => {
  cleanup()
  globalThis.fetch = originalFetch
  delete window.__OAD_API_BASE_URL__
})

describe('Servers rows on touch', () => {
  it('keeps one button on the row and moves Edit and Remove to the sheet', async () => {
    render(<AppBackendPanel active />)
    const more = await screen.findByRole('button', { name: 'More actions for Local CLI' })
    const row = more.closest('[data-server-row]') as HTMLElement
    expect(within(row).getByRole('button', { name: 'Use Local CLI' })).toBeInTheDocument()
    expect(within(row).queryByRole('button', { name: 'Edit Local CLI' })).toBeNull()
    expect(within(row).queryByRole('button', { name: 'Remove Local CLI…' })).toBeNull()

    fireEvent.click(more)
    const sheet = screen.getByRole('dialog', { name: 'Local CLI' })
    const labels = Array.from(sheet.querySelectorAll('button')).map((b) => b.textContent)
    expect(labels).toEqual(['Use this server', 'Edit', 'Remove…', 'Cancel'])
    expect(within(sheet).getByRole('button', { name: 'Remove…' }).className).toContain('text-(--color-error)')
  })

  it('opens the same sheet on a long press, with one medium haptic', async () => {
    render(<AppBackendPanel active />)
    const more = await screen.findByRole('button', { name: 'More actions for Local CLI' })
    const row = more.closest('[data-server-row]') as HTMLElement
    const realSetTimeout = globalThis.setTimeout
    fireEvent.pointerDown(row, { pointerType: 'touch', clientX: 10, clientY: 10 })
    await act(async () => { await new Promise((resolve) => realSetTimeout(resolve, 600)) })
    expect(screen.getByRole('dialog', { name: 'Local CLI' })).toBeInTheDocument()
    expect(haptics).toEqual(['medium'])
  })

  it('a tap on the name uses the server', async () => {
    render(<AppBackendPanel active />)
    const open = await screen.findByRole('button', { name: 'Open Local CLI' })
    calls.length = 0
    fireEvent.click(open)
    await act(async () => { await Promise.resolve() })
    expect(calls.some((call) => call.includes('4082'))).toBe(true)
  })

  it('adds a server in its own sheet', async () => {
    render(<AppBackendPanel active />)
    fireEvent.click(await screen.findByRole('button', { name: 'Add a server' }))
    const sheet = document.querySelector<HTMLElement>('[data-server-sheet]')!
    expect(within(sheet).getByLabelText('Server URL')).toBeInTheDocument()
    expect(sheet.closest('[data-bottom-sheet]')).not.toBeNull()
  })
})
