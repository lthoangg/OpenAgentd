/** The desktop app's watch for devices waiting to join the account. */
import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { http, HttpResponse } from 'msw'
import { setupServer } from '@/__tests__/msw'

const sendDesktopNotification = mock(async (..._args: unknown[]) => {})
mock.module('@/lib/desktop-notifications', () => ({ sendDesktopNotification }))

import type { CloudPending, CloudStatus } from '@/api/cloud'
import { APPROVAL_TEXT, DesktopApprovalWatcher } from '@/components/account/DesktopApprovalWatcher'

const server = setupServer()
let originalFetch: typeof fetch | undefined

const STATUS_URL = 'http://localhost/api/cloud/status'
const PENDING_URL = 'http://localhost/api/cloud/pending'
const BEGIN_URL = 'http://localhost/api/cloud/approve/begin'

const SIGNER: CloudStatus = { state: 'connected', fingerprint: 'AA11 BB22', signer: true } as CloudStatus
const ROW: CloudPending = { enrollment_id: 'enr-1', fingerprint: '9C02 E1B7', country: 'VN', created_at: Date.now() - 5_000, expires_at: null, kind: 'ios' } as CloudPending

let pendingAsked = 0

beforeEach(() => {
  pendingAsked = 0
  sendDesktopNotification.mockClear()
  server.listen()
  originalFetch = globalThis.fetch
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    if (typeof input === 'string' && input.startsWith('/')) {
      return originalFetch?.(`http://localhost${input}`, init) ?? Promise.reject(new Error('fetch unavailable'))
    }
    return originalFetch?.(input, init) ?? Promise.reject(new Error('fetch unavailable'))
  }) as typeof fetch
})

afterEach(() => {
  cleanup()
  server.resetHandlers()
  if (originalFetch) globalThis.fetch = originalFetch
  originalFetch = undefined
  server.close()
})

function serve(status: CloudStatus, pending: () => Response) {
  server.use(
    http.get(STATUS_URL, () => HttpResponse.json(status)),
    http.get(PENDING_URL, () => {
      pendingAsked += 1
      return pending()
    }),
  )
}

function renderWatcher() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  return render(<QueryClientProvider client={queryClient}><DesktopApprovalWatcher /></QueryClientProvider>)
}

describe('DesktopApprovalWatcher', () => {
  it('notifies with fixed text naming no device, and Review opens the approval sheet', async () => {
    serve(SIGNER, () => HttpResponse.json([ROW]))
    server.use(http.post(BEGIN_URL, () => HttpResponse.json({ code: '418207', server: false, client: true })))
    renderWatcher()

    const prompt = await screen.findByRole('dialog')
    expect(within(prompt).getByText(APPROVAL_TEXT)).toBeTruthy()
    expect(sendDesktopNotification).toHaveBeenCalledTimes(1)
    const sent = sendDesktopNotification.mock.calls[0][0] as { kind: string; title: string; body: string }
    expect(sent).toMatchObject({ kind: 'device_approval', title: 'OpenAgentd', body: 'A device wants to join your account' })
    expect(JSON.stringify(sent)).not.toContain('9C02')

    fireEvent.click(within(prompt).getByRole('button', { name: 'Review' }))
    const sheet = await screen.findByRole('dialog')
    expect(await within(sheet).findByText('418 207')).toBeTruthy()
    expect(within(sheet).getByText('Add this device?')).toBeTruthy()
  })

  it('does not ask while this computer does not approve devices', async () => {
    serve({ ...SIGNER, signer: false } as CloudStatus, () => HttpResponse.json([ROW]))
    renderWatcher()
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(pendingAsked).toBe(0)
    expect(sendDesktopNotification).not.toHaveBeenCalled()
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('stops asking a server that answers 403, and shows nothing', async () => {
    serve(SIGNER, () => HttpResponse.json({ detail: 'Only this computer can change its account.' }, { status: 403 }))
    renderWatcher()
    await waitFor(() => expect(pendingAsked).toBe(1))
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(pendingAsked).toBe(1)
    expect(screen.queryByRole('dialog')).toBeNull()
  })
})
