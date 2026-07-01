import { afterEach, describe, expect, it, mock } from 'bun:test'
import { cleanup, render, screen } from '@testing-library/react'
import type { ReactNode } from 'react'

afterEach(cleanup)

mock.module('lucide-react', () => new Proxy({}, { get: () => () => null }))

mock.module('@tanstack/react-router', () => ({
  Link: ({ children, to, ...props }: { children: ReactNode; to: string }) => (
    <a href={to} {...props}>{children}</a>
  ),
}))

mock.module('@/hooks/use-platform', () => ({
  usePlatform: () => ({ isTauri: false, os: null, isMacOverlay: false }),
}))

mock.module('@/hooks/use-tauri-drag', () => ({
  useTauriDrag: () => ({}),
}))

import { PageHeader } from '@/routes/telemetry/chrome'

describe('Telemetry PageHeader', () => {
  it('uses AppHeader chrome with home navigation and offset subtitle', () => {
    render(
      <PageHeader
        isFetching={false}
        subtitle="Span aggregates & latency"
        right={<button type="button">7 d</button>}
      />,
    )

    const header = screen.getByRole('banner')
    expect(header.className).toContain('h-(--spacing-app-header)')
    expect(screen.getByRole('link', { name: 'Home' }).getAttribute('href')).toBe('/')
    expect(screen.getByText('Telemetry')).toBeTruthy()

    const subtitle = screen.getByText('Span aggregates & latency')
    expect(subtitle.parentElement?.className).toContain('ml-4')
    expect(screen.getByRole('button', { name: '7 d' })).toBeTruthy()
  })

  it('keeps trace back control in the center cluster and exposes refreshing state', () => {
    render(
      <PageHeader
        isFetching
        left={<button type="button">Back to list</button>}
        subtitle="Trace abc123"
      />,
    )

    const subtitle = screen.getByText('Trace abc123')
    expect(subtitle.parentElement?.contains(screen.getByRole('button', { name: 'Back to list' }))).toBe(true)
    expect(screen.getByLabelText('Refreshing')).toBeTruthy()
    expect(screen.getByText('local')).toBeTruthy()
  })
})
