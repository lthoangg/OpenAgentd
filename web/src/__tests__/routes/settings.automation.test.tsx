/**
 * Automation page — replaces the former settings.multimodal,
 * settings.summarization and settings.title-generation suites.
 *
 * The behavioural change these tests lock in: the Save affordance is a sticky
 * bar that only exists while there are unsaved edits, and each collapsible
 * group saves independently so an untouched group is never PUT.
 */
import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { http, HttpResponse } from 'msw'
import { setupServer } from 'msw/node'
import type { ReactNode } from 'react'

import { ToastStack } from '@/components/ToastStack'
import { useToastStore, type Toast } from '@/stores/useToastStore'

mock.module('@tanstack/react-router', () => ({
  Link: ({ children }: { children: ReactNode }) => children,
}))

mock.module('@/hooks/use-mobile', () => ({
  useIsMobile: () => false,
}))

import { AutomationSettingsPage } from '@/components/settings/pages/settings.automation'

const server = setupServer()
let originalFetch: typeof fetch | undefined

const TITLES = {
  enabled: true,
  model: 'codex:gpt-5.5-mini',
  wait_timeout_seconds: 3,
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

function renderPage() {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  })
  return render(
    <QueryClientProvider client={queryClient}>
      <AutomationSettingsPage />
      <ToastStack />
    </QueryClientProvider>,
  )
}

/** Collapses an open disclosure group by its heading. */
async function collapseGroup(name: RegExp) {
  const header = await screen.findByRole('button', { name })
  fireEvent.click(header)
  return header
}

describe('AutomationSettingsPage', () => {
  it('groups the three former sections onto one page', async () => {
    server.use(...baseHandlers())
    renderPage()

    expect(await screen.findByRole('button', { name: /chat titles/i })).toBeTruthy()
    expect(screen.getByRole('button', { name: /summarization/i })).toBeTruthy()
    expect(screen.getByRole('button', { name: /image and video/i })).toBeTruthy()
  })

  it('shows no save bar until something is edited', async () => {
    server.use(...baseHandlers())
    renderPage()

    await screen.findByRole('button', { name: /chat titles/i })
    expect(screen.queryByText('Unsaved changes')).toBeNull()
    expect(screen.queryByRole('button', { name: /^save$/i })).toBeNull()
  })

  it('opens all three groups on arrival', async () => {
    server.use(...baseHandlers(null))
    renderPage()

    // A control from each group is reachable without any clicking.
    expect(await screen.findByLabelText('Wait timeout seconds')).toBeTruthy()
    expect(screen.getByLabelText('Token threshold')).toBeTruthy()
    expect(screen.getByLabelText('Image model')).toBeTruthy()
  })

  it('summarizes group state once collapsed, using Auto for a null threshold', async () => {
    server.use(...baseHandlers(null))
    renderPage()

    await collapseGroup(/summarization/i)
    expect(await screen.findByText('Auto')).toBeTruthy()
  })

  it('shows a formatted token count for a collapsed custom threshold', async () => {
    server.use(...baseHandlers(80_000))
    renderPage()

    await collapseGroup(/summarization/i)
    expect(await screen.findByText('80,000 tokens')).toBeTruthy()
  })

  it('reveals the save bar on edit and saves only the edited group', async () => {
    let multimodalPuts = 0
    let titlesPuts = 0
    server.use(
      ...baseHandlers(null),
      http.put('http://localhost/api/settings/summarization', () =>
        HttpResponse.json({ prompt_token_threshold: 50_000 }),
      ),
      http.put('http://localhost/api/settings/multimodal', () => {
        multimodalPuts += 1
        return HttpResponse.json(MULTIMODAL)
      }),
      http.put('http://localhost/api/settings/title-generation', () => {
        titlesPuts += 1
        return HttpResponse.json(TITLES)
      }),
    )
    renderPage()

    const input = await screen.findByLabelText('Token threshold')
    fireEvent.change(input, { target: { value: '50000' } })

    await waitFor(() => {
      expect(screen.queryByText('Unsaved changes')).not.toBeNull()
    })

    fireEvent.click(screen.getByRole('button', { name: /^save$/i }))

    await waitFor(() => {
      expect(useToastStore.getState().toasts.some((t: Toast) => t.tone === 'success')).toBe(true)
    })

    // Untouched groups must not be written back.
    expect(multimodalPuts).toBe(0)
    expect(titlesPuts).toBe(0)
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
    renderPage()

    const input = await screen.findByLabelText('Token threshold')
    fireEvent.change(input, { target: { value: '' } })

    fireEvent.click(await screen.findByRole('button', { name: /^save$/i }))

    await waitFor(() => {
      expect(useToastStore.getState().toasts.some((t: Toast) => t.tone === 'success')).toBe(true)
    })
  })

  it('discards edits when Reset is pressed', async () => {
    server.use(...baseHandlers(80_000))
    renderPage()

    const input = (await screen.findByLabelText('Token threshold')) as HTMLInputElement
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
    renderPage()

    fireEvent.change(await screen.findByLabelText('Token threshold'), {
      target: { value: '30000' },
    })
    fireEvent.click(await screen.findByRole('button', { name: /^save$/i }))

    await waitFor(() => {
      expect(useToastStore.getState().toasts.some((t: Toast) => t.tone === 'error')).toBe(true)
    })
  })

  it('keeps save-bar and group controls touch-sized before desktop sizing', async () => {
    server.use(...baseHandlers(null))
    renderPage()

    // Chat titles is open by default, so its controls are reachable immediately.
    const enabled = await screen.findByRole('switch', {
      name: /generate titles automatically/i,
    })
    expect(enabled.parentElement?.className).toContain('min-h-11')
    expect(enabled.parentElement?.className).toContain('md:min-h-0')

    const waitTimeout = screen.getByLabelText('Wait timeout seconds')
    expect(waitTimeout.className).toContain('min-h-11')
    expect(waitTimeout.className).toContain('md:min-h-9')

    // Dirty the page so the save bar mounts, then assert its touch targets.
    fireEvent.change(waitTimeout, { target: { value: '5' } })

    const save = await screen.findByRole('button', { name: /^save$/i })
    expect(save.className).toContain('min-h-11')
    expect(save.className).toContain('md:min-h-0')

    const reset = screen.getByRole('button', { name: /reset/i })
    expect(reset.className).toContain('min-h-11')
    expect(reset.className).toContain('md:min-h-0')
  })

  it('keeps image and video model inputs touch-sized', async () => {
    server.use(...baseHandlers(null))
    renderPage()

    await screen.findByLabelText('Image model')

    const inputs = Array.from(document.querySelectorAll('input')).filter((input) =>
      /googlegenai/.test(input.value),
    )
    expect(inputs.length).toBe(2)
    for (const input of inputs) {
      expect(input.className).toContain('min-h-11')
      expect(input.className).toContain('md:min-h-9')
    }
  })
})
