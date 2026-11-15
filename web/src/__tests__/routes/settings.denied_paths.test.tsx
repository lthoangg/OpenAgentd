import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { http, HttpResponse } from 'msw'
import { setupServer } from '@/__tests__/msw'
import type { ReactNode } from 'react'

import { ToastStack } from '@/components/ToastStack'
import { useToastStore } from '@/stores/useToastStore'

mock.module('@tanstack/react-router', () => ({
  Link: ({ children }: { children: ReactNode }) => children,
}))

mock.module('@/hooks/use-mobile', () => ({
  useIsMobile: () => false,
}))

import { DeniedPathsSettingsPage } from '@/components/settings/pages/settings.denied_paths'

const server = setupServer()
let originalFetch: typeof fetch | undefined

beforeEach(() => {
  useToastStore.setState({ toasts: [] })
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

function renderPage() {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  })

  return render(
    <QueryClientProvider client={queryClient}>
      <DeniedPathsSettingsPage />
      <ToastStack />
    </QueryClientProvider>,
  )
}

const patterns = (list: string[]) =>
  http.get('http://localhost/api/settings/denied-paths', () => HttpResponse.json({ denied_patterns: list }))

describe('DeniedPathsSettingsPage', () => {
  it('is titled Blocked files and says what blocking covers', async () => {
    server.use(patterns([]))
    renderPage()
    expect(await screen.findByRole('heading', { name: 'Blocked files' })).toBeTruthy()
    expect(screen.getByText(/Files and folders agents cannot read or change\./)).toBeTruthy()
    expect(screen.queryByText(/Denied/)).toBeNull()
  })

  it('says nothing is blocked, and offers a folder first', async () => {
    server.use(patterns([]))
    renderPage()
    expect(await screen.findByText('Nothing is blocked')).toBeTruthy()
    expect(screen.getByText('Agents can read and change the files in the workspace they work in.')).toBeTruthy()
    const folder = screen.getByRole('button', { name: 'Block a folder…' })
    expect(folder.className).toContain('min-h-9')
    expect(folder.className).toContain('md:min-h-0')
    // The examples are on the page, not behind a popover.
    expect(screen.queryByRole('button', { name: /See examples/i })).toBeNull()
    expect(screen.getByText('Add a pattern')).toBeTruthy()
  })

  it('reads each rule as a sentence with its pattern under it', async () => {
    server.use(patterns(['**/.env', '/Users/me/Documents/taxes/**', '**/*.pem']))
    renderPage()
    const env = await screen.findByRole('textbox', { name: 'Any file named .env' }) as HTMLInputElement
    expect(env.value).toBe('**/.env')
    expect((screen.getByRole('textbox', { name: 'Everything in taxes' }) as HTMLInputElement).value).toBe('/Users/me/Documents/taxes/**')
    expect((screen.getByRole('textbox', { name: 'Any .pem file' }) as HTMLInputElement).value).toBe('**/*.pem')
  })

  it('keeps row actions touch-sized before desktop compact sizing', async () => {
    server.use(
      patterns(['**/.env']),
      http.put('http://localhost/api/settings/denied-paths', () => HttpResponse.json({ denied_patterns: ['**/.env'] })),
    )
    renderPage()
    const pattern = await screen.findByDisplayValue('**/.env')

    // The save bar only mounts once there are unsaved edits.
    expect(screen.queryByRole('button', { name: /^Save$/i })).toBeNull()
    fireEvent.change(pattern, { target: { value: '**/.env.local' } })
    expect((await screen.findByRole('button', { name: /^Save$/i })).className).toContain('min-h-9')

    const remove = screen.getByRole('button', { name: 'Remove “**/.env.local”' })
    expect(remove.className).toContain('h-9')
    expect(remove.className).toContain('w-9')
    expect(remove.className).toContain('md:h-7')
    expect(remove.className).toContain('md:w-7')
  })

  it('adds an example with one press, and stops offering it', async () => {
    server.use(patterns(['**/.env']))
    renderPage()
    await screen.findByDisplayValue('**/.env')
    // What is already blocked is not offered again.
    expect(screen.queryByRole('button', { name: 'Add “**/.env”' })).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'Add “**/*.pem”' }))
    expect((screen.getByRole('textbox', { name: 'Any .pem file' }) as HTMLInputElement).value).toBe('**/*.pem')
    expect(screen.queryByRole('button', { name: 'Add “**/*.pem”' })).toBeNull()
    expect(await screen.findByRole('region', { name: 'Unsaved changes' })).toBeTruthy()
  })

  it('adds an empty row for a pattern of your own', async () => {
    server.use(patterns(['**/.env']))
    renderPage()
    await screen.findByDisplayValue('**/.env')
    fireEvent.click(screen.getByRole('button', { name: 'Write your own' }))
    expect((screen.getByRole('textbox', { name: 'New pattern' }) as HTMLInputElement).value).toBe('')
  })

  it('blocks a folder picked from the computer the agents run on', async () => {
    let saved: unknown = null
    server.use(
      patterns([]),
      http.get('http://localhost/api/agent/workspace/browse', ({ request }) => {
        const path = new URL(request.url).searchParams.get('path')
        if (path === '/Users/me/Documents') {
          return HttpResponse.json({ path, parent: '/Users/me', directories: [{ name: 'taxes', path: '/Users/me/Documents/taxes' }] })
        }
        return HttpResponse.json({ path: '/Users/me', parent: '/Users', directories: [{ name: 'Documents', path: '/Users/me/Documents' }] })
      }),
      http.put('http://localhost/api/settings/denied-paths', async ({ request }) => {
        saved = await request.json()
        return HttpResponse.json(saved as object)
      }),
    )
    renderPage()
    fireEvent.click(await screen.findByRole('button', { name: 'Block a folder…' }))

    const dialog = await screen.findByRole('dialog', { name: 'Block a folder' })
    fireEvent.click(await within(dialog).findByRole('button', { name: 'Documents' }))
    await within(dialog).findByRole('button', { name: 'taxes' })
    expect(within(dialog).getByText('/Users/me/Documents')).toBeTruthy()
    fireEvent.click(within(dialog).getByRole('button', { name: 'Block this folder' }))

    // The dialog closes on its own once the folder is picked.
    await waitFor(() => expect(document.querySelectorAll('[role="dialog"]').length).toBe(0))
    expect((screen.getByRole('textbox', { name: 'Everything in Documents' }) as HTMLInputElement).value).toBe('/Users/me/Documents/**')

    fireEvent.click(await screen.findByRole('button', { name: /^Save$/i }))
    await waitFor(() => expect(saved).toEqual({ denied_patterns: ['/Users/me/Documents/**'] }))
    expect(await screen.findByText('Blocked files saved')).toBeTruthy()
  })
})
