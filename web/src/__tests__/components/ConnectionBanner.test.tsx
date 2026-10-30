import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'

let health: { isSuccess: boolean; isError: boolean; isPending: boolean } = { isSuccess: true, isError: false, isPending: false }
let external = false
mock.module('@/queries/useHealthQuery', () => ({
  useHealthQuery: () => health,
  useBackendStatusQuery: () => ({
    data: {
      mode: external ? 'external' : 'bundled',
      base_url: external ? 'http://192.168.1.20:8000' : 'http://127.0.0.1:4082',
      sidecar_running: true,
      external,
      supports_bundled: true,
      servers: [],
    },
  }),
}))
mock.module('@/components/AppBackendDialog', () => ({
  AppBackendDialog: ({ open }: { open: boolean }) => (open ? <div role="dialog" aria-label="Backend connection" /> : null),
}))

import { ConnectionBanner } from '@/components/ConnectionBanner'

beforeEach(() => {
  health = { isSuccess: true, isError: false, isPending: false }
  external = false
})
afterEach(cleanup)

describe('ConnectionBanner', () => {
  it('stays hidden while the backend answers', () => {
    render(<ConnectionBanner />)
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('stays hidden during the first check and while retries are still running', () => {
    // A refetch that is still retrying keeps the last status, so a short
    // drop never reaches isError.
    health = { isSuccess: false, isError: false, isPending: true }
    render(<ConnectionBanner />)
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('names the built-in server once the health check has failed', () => {
    health = { isSuccess: false, isError: true, isPending: false }
    render(<ConnectionBanner />)
    expect(screen.getByRole('alert').textContent).toContain("Can't reach the built-in server. Retrying…")
  })

  it('names the remote server by its host', () => {
    health = { isSuccess: false, isError: true, isPending: false }
    external = true
    render(<ConnectionBanner />)
    expect(screen.getByRole('alert').textContent).toContain("Can't reach 192.168.1.20. Retrying…")
  })

  it('opens the backend connection dialog from Change server', async () => {
    health = { isSuccess: false, isError: true, isPending: false }
    render(<ConnectionBanner />)
    fireEvent.click(screen.getByRole('button', { name: 'Change server' }))
    expect(await screen.findByRole('dialog', { name: 'Backend connection' })).toBeTruthy()
  })

  it('goes away when the backend answers again, keeping an open dialog', async () => {
    health = { isSuccess: false, isError: true, isPending: false }
    const { rerender } = render(<ConnectionBanner />)
    fireEvent.click(screen.getByRole('button', { name: 'Change server' }))
    await screen.findByRole('dialog', { name: 'Backend connection' })

    health = { isSuccess: true, isError: false, isPending: false }
    rerender(<ConnectionBanner />)

    expect(screen.queryByRole('alert')).toBeNull()
    expect(screen.getByRole('dialog', { name: 'Backend connection' })).toBeTruthy()
  })
})
