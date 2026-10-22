/**
 * The pages split out of the former Automation page: Workspaces, Chat titles,
 * Context and Media generation.
 *
 * The behaviour these tests lock in: the Save affordance is a sticky bar that
 * only exists while there are unsaved edits, and each page saves only its own
 * resource.
 */
import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { http, HttpResponse } from 'msw'
import { setupServer } from '@/__tests__/msw'
import type { ReactNode } from 'react'

import { ToastStack } from '@/components/ToastStack'
import { useToastStore, type Toast } from '@/stores/useToastStore'

mock.module('@tanstack/react-router', () => ({
  Link: ({ children }: { children: ReactNode }) => children,
}))

mock.module('@/hooks/use-mobile', () => ({
  useIsMobile: () => false,
}))

import { WorkspacesSettingsPage } from '@/components/settings/pages/settings.workspaces'
import { TitlesSettingsPage } from '@/components/settings/pages/settings.titles'
import { ContextSettingsPage } from '@/components/settings/pages/settings.context'
import { MediaSettingsPage } from '@/components/settings/pages/settings.media'

const server = setupServer()
let originalFetch: typeof fetch | undefined

const TITLES = {
  enabled: true,
  model: 'codex:gpt-5.5-mini',
  wait_timeout_seconds: 3,
  update_after_compaction: false,
}

const MULTIMODAL = {
  image: {
    model: 'googlegenai:gemini-3.1-flash-image-preview',
    aspect_ratio: '1:1',
    image_size: '1K',
  },
  video: {
    model: 'googlegenai:veo-3.1-generate-preview',
    aspect_ratio: '16:9',
    resolution: '720p',
    duration_seconds: '8',
  },
}

const REGISTRY = {
  agents: [],
  skills: [],
  tools: [],
  models: [
    { id: 'codex:gpt-5.5-mini' },
    { id: 'googlegenai:gemini-3.1-flash-image-preview', output_image: true },
    { id: 'googlegenai:veo-3.1-generate-preview', output_video: true },
  ],
}

/** Happy-path GETs for all three resources plus the model registry. */
function baseHandlers(threshold: number | null = null) {
  return [
    http.get('http://localhost/api/settings/title-generation', () => HttpResponse.json(TITLES)),
    http.get('http://localhost/api/settings/summarization', () =>
      HttpResponse.json({ prompt_token_threshold: threshold }),
    ),
    http.get('http://localhost/api/settings/multimodal', () => HttpResponse.json(MULTIMODAL)),
    http.get('http://localhost/api/settings/workspace-messages', () => HttpResponse.json({ enabled: true })),
    http.get('http://localhost/api/agent/workspace/tree', () =>
      HttpResponse.json({
        repositories: [{ path: '/repo/web', name: 'web', worktrees: [], group_ids: ['g-acme'] }],
        chat: null,
        groups: [{ id: 'g-acme', name: 'acme', brief: 'web = frontend', color: '#3b82f6' }],
      }),
    ),
    http.get('http://localhost/api/agents/registry', () => HttpResponse.json(REGISTRY)),
  ]
}

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

function renderPage(page: ReactNode) {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  })
  return render(
    <QueryClientProvider client={queryClient}>
      {page}
      <ToastStack />
    </QueryClientProvider>,
  )
}

describe('WorkspacesSettingsPage', () => {
  it('sets up workspace groups under the messages switch', async () => {
    server.use(...baseHandlers())
    renderPage(<WorkspacesSettingsPage />)

    expect(await screen.findByRole('heading', { level: 1, name: 'Workspaces' })).toBeTruthy()
    expect(await screen.findByRole('list', { name: 'Members of acme' })).toBeTruthy()
    expect(screen.getByText('web = frontend')).toBeTruthy()
    expect(screen.queryByText('Unsaved changes')).toBeNull()
  })

  it('turns workspace messages off through the save bar', async () => {
    const bodies: unknown[] = []
    server.use(
      ...baseHandlers(null),
      http.put('http://localhost/api/settings/workspace-messages', async ({ request }) => {
        bodies.push(await request.json())
        return HttpResponse.json({ enabled: false })
      }),
    )
    renderPage(<WorkspacesSettingsPage />)

    const toggle = await screen.findByRole('switch', { name: /let agents message other workspaces/i })
    await waitFor(() => expect(toggle.getAttribute('aria-checked')).toBe('true'))
    // The switch sits in a 56px settings row whose label also toggles it.
    expect(toggle.closest('.min-h-14')).not.toBeNull()
    fireEvent.click(toggle)
    fireEvent.click(await screen.findByRole('button', { name: /^save$/i }))

    await waitFor(() => expect(bodies).toEqual([{ enabled: false }]))
  })
})

describe('TitlesSettingsPage', () => {
  it('shows no save bar until something is edited', async () => {
    server.use(...baseHandlers())
    renderPage(<TitlesSettingsPage />)

    await screen.findByLabelText('Wait timeout seconds')
    expect(screen.queryByText('Unsaved changes')).toBeNull()
    expect(screen.queryByRole('button', { name: /^save$/i })).toBeNull()
  })

  it('keeps save-bar and row controls touch-sized before desktop sizing', async () => {
    server.use(...baseHandlers(null))
    renderPage(<TitlesSettingsPage />)

    const enabled = await screen.findByRole('switch', { name: /generate titles automatically/i })
    expect(enabled.closest('.min-h-14')).not.toBeNull()
    expect(document.querySelector(`label[for="${enabled.id}"]`)?.textContent).toMatch(/generate titles automatically/i)

    const waitTimeout = screen.getByLabelText('Wait timeout seconds')
    expect(waitTimeout.className).toContain('h-9')

    fireEvent.change(waitTimeout, { target: { value: '5' } })

    const save = await screen.findByRole('button', { name: /^save$/i })
    expect(save.className).toContain('min-h-9')
    expect(save.className).toContain('md:min-h-0')

    const reset = screen.getByRole('button', { name: /reset/i })
    expect(reset.className).toContain('min-h-9')
    expect(reset.className).toContain('md:min-h-0')
  })

  it('hides the model and timeout rows while titles are off', async () => {
    server.use(...baseHandlers(null))
    renderPage(<TitlesSettingsPage />)

    const enabled = await screen.findByRole('switch', { name: /generate titles automatically/i })
    await waitFor(() => expect(enabled.getAttribute('aria-checked')).toBe('true'))
    fireEvent.click(enabled)
    await waitFor(() => expect(screen.queryByLabelText('Wait timeout seconds')).toBeNull())
    expect(screen.queryByRole('switch', { name: /update title after compaction/i })).toBeNull()
  })

  it('turns on retitling after compaction', async () => {
    const bodies: unknown[] = []
    server.use(
      ...baseHandlers(null),
      http.put('http://localhost/api/settings/title-generation', async ({ request }) => {
        const body = await request.json()
        bodies.push(body)
        return HttpResponse.json(body as object)
      }),
    )
    renderPage(<TitlesSettingsPage />)

    const toggle = await screen.findByRole('switch', { name: /update title after compaction/i })
    await waitFor(() => expect(toggle.getAttribute('aria-checked')).toBe('false'))
    fireEvent.click(toggle)
    fireEvent.click(await screen.findByRole('button', { name: /^save$/i }))

    await waitFor(() => expect(bodies).toEqual([{ ...TITLES, update_after_compaction: true }]))
  })
})

describe('ContextSettingsPage', () => {
  it('saves an edited threshold', async () => {
    const bodies: unknown[] = []
    server.use(
      ...baseHandlers(null),
      http.put('http://localhost/api/settings/summarization', async ({ request }) => {
        const body = await request.json()
        bodies.push(body)
        return HttpResponse.json(body as object)
      }),
    )
    renderPage(<ContextSettingsPage />)

    const input = await screen.findByLabelText('Token threshold')
    fireEvent.change(input, { target: { value: '50000' } })
    await waitFor(() => expect(screen.queryByText('Unsaved changes')).not.toBeNull())
    fireEvent.click(screen.getByRole('button', { name: /^save$/i }))

    await waitFor(() => {
      expect(useToastStore.getState().toasts.some((t: Toast) => t.tone === 'success')).toBe(true)
    })
    expect(bodies).toEqual([{ prompt_token_threshold: 50_000, idle_compaction: false, idle_compaction_percent: null }])
  })

  it('clears the threshold when the field is emptied', async () => {
    server.use(
      ...baseHandlers(80_000),
      http.put('http://localhost/api/settings/summarization', async ({ request }) => {
        const body = (await request.json()) as { prompt_token_threshold: number | null }
        expect(body.prompt_token_threshold).toBeNull()
        return HttpResponse.json({ prompt_token_threshold: null })
      }),
    )
    renderPage(<ContextSettingsPage />)

    const input = await screen.findByLabelText('Token threshold')
    await waitFor(() => expect((input as HTMLInputElement).value).toBe('80000'))
    fireEvent.change(input, { target: { value: '' } })

    fireEvent.click(await screen.findByRole('button', { name: /^save$/i }))

    await waitFor(() => {
      expect(useToastStore.getState().toasts.some((t: Toast) => t.tone === 'success')).toBe(true)
    })
  })

  it('discards edits when Reset is pressed', async () => {
    server.use(...baseHandlers(80_000))
    renderPage(<ContextSettingsPage />)

    const input = (await screen.findByLabelText('Token threshold')) as HTMLInputElement
    await waitFor(() => expect(input.value).toBe('80000'))
    fireEvent.change(input, { target: { value: '1234' } })

    await waitFor(() => expect(screen.queryByText('Unsaved changes')).not.toBeNull())

    fireEvent.click(screen.getByRole('button', { name: /reset/i }))

    await waitFor(() => {
      expect(screen.queryByText('Unsaved changes')).toBeNull()
    })
    expect((screen.getByLabelText('Token threshold') as HTMLInputElement).value).toBe('80000')
  })

  it('reports a failed save as an error toast', async () => {
    server.use(
      ...baseHandlers(null),
      http.put('http://localhost/api/settings/summarization', () =>
        HttpResponse.json({ detail: 'internal error' }, { status: 500 }),
      ),
    )
    renderPage(<ContextSettingsPage />)

    fireEvent.change(await screen.findByLabelText('Token threshold'), {
      target: { value: '30000' },
    })
    fireEvent.click(await screen.findByRole('button', { name: /^save$/i }))

    await waitFor(() => {
      expect(useToastStore.getState().toasts.some((t: Toast) => t.tone === 'error')).toBe(true)
    })
  })

  it('keeps idle compaction off with its percent shown but disabled for an older backend', async () => {
    // baseHandlers returns only prompt_token_threshold, like an older backend.
    server.use(...baseHandlers(null))
    renderPage(<ContextSettingsPage />)

    const toggle = await screen.findByRole('switch', { name: /compact idle sessions/i })
    expect(toggle.getAttribute('aria-checked')).toBe('false')
    const percent = screen.getByLabelText('Idle trigger percent') as HTMLInputElement
    expect(percent.disabled).toBe(true)
    expect(percent.placeholder).toBe('70')
    expect(screen.queryByText('Unsaved changes')).toBeNull()

    fireEvent.click(toggle)
    await waitFor(() => expect(percent.disabled).toBe(false))
  })

  it('turns idle compaction on with a custom percent', async () => {
    const bodies: unknown[] = []
    server.use(
      ...baseHandlers(null),
      http.put('http://localhost/api/settings/summarization', async ({ request }) => {
        const body = await request.json()
        bodies.push(body)
        return HttpResponse.json(body as object)
      }),
    )
    renderPage(<ContextSettingsPage />)

    fireEvent.click(await screen.findByRole('switch', { name: /compact idle sessions/i }))
    const percent = await screen.findByLabelText('Idle trigger percent')
    fireEvent.change(percent, { target: { value: '55' } })
    fireEvent.click(await screen.findByRole('button', { name: /^save$/i }))

    await waitFor(() =>
      expect(bodies).toEqual([
        { prompt_token_threshold: null, idle_compaction: true, idle_compaction_percent: 55 },
      ]),
    )
  })

  it('sends null for an empty percent', async () => {
    const bodies: unknown[] = []
    server.use(
      ...baseHandlers(null),
      http.put('http://localhost/api/settings/summarization', async ({ request }) => {
        const body = await request.json()
        bodies.push(body)
        return HttpResponse.json(body as object)
      }),
    )
    renderPage(<ContextSettingsPage />)

    fireEvent.click(await screen.findByRole('switch', { name: /compact idle sessions/i }))
    fireEvent.click(await screen.findByRole('button', { name: /^save$/i }))
    await waitFor(() =>
      expect(bodies).toEqual([
        { prompt_token_threshold: null, idle_compaction: true, idle_compaction_percent: null },
      ]),
    )
  })

  it.each(['0', '101'])('blocks saving an idle percent of %s', async (value) => {
    let puts = 0
    server.use(
      ...baseHandlers(null),
      http.put('http://localhost/api/settings/summarization', () => {
        puts += 1
        return HttpResponse.json({})
      }),
    )
    renderPage(<ContextSettingsPage />)

    fireEvent.click(await screen.findByRole('switch', { name: /compact idle sessions/i }))
    fireEvent.change(await screen.findByLabelText('Idle trigger percent'), { target: { value } })

    expect(await screen.findByText(/whole number from 1 to 100/i)).toBeTruthy()
    const save = screen.getByRole('button', { name: /^save$/i }) as HTMLButtonElement
    expect(save.disabled).toBe(true)
    fireEvent.click(save)
    expect(puts).toBe(0)
  })
})

describe('MediaSettingsPage', () => {
  it('shows image and video sections with touch-sized model inputs', async () => {
    server.use(...baseHandlers(null))
    renderPage(<MediaSettingsPage />)

    await screen.findByLabelText('Image model')
    expect(screen.getByLabelText('Video model')).toBeTruthy()
    expect(screen.getByRole('heading', { name: 'Image generation' })).toBeTruthy()
    expect(screen.getByRole('heading', { name: 'Video generation' })).toBeTruthy()

    const inputs = Array.from(document.querySelectorAll('input')).filter((input) =>
      /googlegenai/.test(input.value),
    )
    expect(inputs.length).toBe(2)
    for (const input of inputs) {
      expect(input.className).toContain('min-h-9')
    }
  })
})
