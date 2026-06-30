import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen } from '@testing-library/react'
import { http, HttpResponse } from 'msw'
import { setupServer } from 'msw/node'
import type { ReactNode } from 'react'

import { ToastStack } from '@/components/ToastStack'
import { useToastStore } from '@/stores/useToastStore'

mock.module('@tanstack/react-router', () => ({
  Link: ({ children }: { children: ReactNode }) => children,
}))

mock.module('@/hooks/use-mobile', () => ({
  useIsMobile: () => false,
}))

import { MultimodalSettingsPage } from '@/routes/settings.multimodal'

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
      <MultimodalSettingsPage />
      <ToastStack />
    </QueryClientProvider>,
  )
}

describe('MultimodalSettingsPage', () => {
  it('keeps multimodal controls touch-sized before desktop compact sizing', async () => {
    server.use(
      http.get('http://localhost/api/settings/multimodal', () => HttpResponse.json({
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
      })),
      http.get('http://localhost/api/agents/registry', () => HttpResponse.json({
        agents: [],
        skills: [],
        tools: [],
        models: [
          { id: 'googlegenai:gemini-3.1-flash-image-preview', output_image: true },
          { id: 'googlegenai:veo-3.1-generate-preview', output_video: true },
        ],
      })),
    )

    renderPage()

    const save = screen.getByRole('button', { name: /save/i })
    expect(save.className).toContain('min-h-11')
    expect(save.className).toContain('md:min-h-0')

    expect(await screen.findByText(/default model and options for image generation/i)).toBeTruthy()
    const buttons = Array.from(document.querySelectorAll('button')).filter((button) =>
      /Provider default|1:1|landscape|portrait|auto|png|standard/.test(button.textContent ?? ''),
    ) as HTMLElement[]
    const inputs = Array.from(document.querySelectorAll('input')).filter((input) =>
      /googlegenai/.test(input.value),
    ) as HTMLInputElement[]

    expect(buttons.length).toBeGreaterThanOrEqual(4)
    expect(inputs.length).toBe(2)

    for (const button of buttons) {
      expect(button.className).toContain('px-2')
      expect(button.className).toContain('py-1')
    }
    for (const input of inputs) {
      expect(input.className).toContain('min-h-11')
      expect(input.className).toContain('md:min-h-9')
    }
  })
})
