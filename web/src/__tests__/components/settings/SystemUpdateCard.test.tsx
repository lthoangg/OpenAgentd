import '@testing-library/jest-dom'

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { setupServer } from 'msw/node'

import { ToastStack } from '@/components/ToastStack'
import { queryKeys } from '@/queries'
import { useToastStore } from '@/stores/useToastStore'
import { SystemUpdateCard } from '@/routes/settings.index'

const server = setupServer()

let originalFetch: typeof fetch | undefined

beforeEach(() => {
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
  server.resetHandlers()
  useToastStore.setState({ toasts: [] })
  if (originalFetch) globalThis.fetch = originalFetch
  originalFetch = undefined
  server.close()
})

function renderCard() {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false, staleTime: Number.POSITIVE_INFINITY },
      mutations: { retry: false },
    },
  })
  queryClient.setQueryData(queryKeys.health(), { status: 'ok', version: '1.2.3' })
  const result = render(
    <QueryClientProvider client={queryClient}>
      <SystemUpdateCard />
      <ToastStack />
    </QueryClientProvider>,
  )
  return {
    ...result,
    unmount: () => {
      result.unmount()
      queryClient.clear()
    },
  }
}

describe('SystemUpdateCard', () => {
  it('shows the current version from the health endpoint before checking updates', async () => {
    renderCard()

    expect(await screen.findByText('v1.2.3')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /^install$/i })).not.toBeInTheDocument()
  })

  it('shows an available update and enables install after checking', async () => {
    server.use(
      http.get('http://localhost/api/settings/update', () =>
        HttpResponse.json({
          current_version: '1.2.3',
          latest_version: '1.2.4',
          update_available: true,
          can_install: true,
          install_blocked_reason: null,
        }),
      ),
    )
    const user = userEvent.setup()
    renderCard()

    await user.click(screen.getByRole('button', { name: /check for updates/i }))

    expect(await screen.findByText('New update v1.2.4 is available.')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /^install$/i })).toBeEnabled()
    expect(screen.getByText('New update v1.2.4')).toBeInTheDocument()
  })

  it('keeps install disabled when the server reports a blocked install', async () => {
    server.use(
      http.get('http://localhost/api/settings/update', () =>
        HttpResponse.json({
          current_version: '1.2.3',
          latest_version: '1.2.4',
          update_available: true,
          can_install: false,
          install_blocked_reason: 'Automatic install is only available for the installed app.',
        }),
      ),
    )
    const user = userEvent.setup()
    renderCard()

    await user.click(screen.getByRole('button', { name: /check for updates/i }))

    expect(
      await screen.findByText('Automatic install is only available for the installed app.'),
    ).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /^install$/i })).toBeDisabled()
  })

  it('starts install and shows a success toast', async () => {
    server.use(
      http.get('http://localhost/api/settings/update', () =>
        HttpResponse.json({
          current_version: '1.2.3',
          latest_version: '1.2.4',
          update_available: true,
          can_install: true,
          install_blocked_reason: null,
        }),
      ),
      http.post('http://localhost/api/settings/update/install', () =>
        HttpResponse.json({ status: 'started' }),
      ),
    )
    const user = userEvent.setup()
    renderCard()

    await user.click(screen.getByRole('button', { name: /check for updates/i }))
    await user.click(await screen.findByRole('button', { name: /^install$/i }))

    expect(await screen.findByText('Update started')).toBeInTheDocument()
    expect(
      screen.getByText('OpenAgentd will install the update and restart in the background.'),
    ).toBeInTheDocument()
  })

  it('shows an inline error and error toast when the update check fails', async () => {
    server.use(
      http.get('http://localhost/api/settings/update', () =>
        HttpResponse.json({ detail: 'Could not check for updates' }, { status: 502 }),
      ),
    )
    const user = userEvent.setup()
    renderCard()

    await user.click(screen.getByRole('button', { name: /check for updates/i }))

    await waitFor(() => {
      expect(screen.getAllByText('Could not check for updates').length).toBeGreaterThan(0)
    })
    expect(screen.getByText('Update check failed')).toBeInTheDocument()
  })
})
