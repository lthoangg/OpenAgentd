/**
 * The phone landing view of Settings: every visible section, grouped.
 */
import '@testing-library/jest-dom'

import { afterEach, describe, expect, it } from 'bun:test'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

import { queryKeys } from '@/queries'
import { SETTINGS_GROUPS, SETTINGS_SECTIONS, type TopLevelSection } from '@/components/settings/sections'
import { SettingsMobileIndex } from '@/components/settings/SettingsMobileIndex'

const originalFetch = globalThis.fetch

function renderIndex(capabilities: string[] = [], onSelect: (section: TopLevelSection) => void = () => {}) {
  globalThis.fetch = (() => Promise.reject(new Error('network disabled in test'))) as unknown as typeof fetch
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Number.POSITIVE_INFINITY } },
  })
  queryClient.setQueryData(queryKeys.health(), { status: 'ok', version: '3.0.0', capabilities })
  return render(
    <QueryClientProvider client={queryClient}>
      <SettingsMobileIndex onSelect={onSelect} />
    </QueryClientProvider>,
  )
}

afterEach(() => {
  cleanup()
  globalThis.fetch = originalFetch
})

describe('SettingsMobileIndex', () => {
  it('lists every group and every section that needs no capability or desktop shell', () => {
    renderIndex()
    for (const group of SETTINGS_GROUPS) {
      expect(screen.getByRole('heading', { name: group.label })).toBeInTheDocument()
    }
    for (const section of SETTINGS_SECTIONS.filter((s) => !s.capability && !s.desktopOnly)) {
      expect(screen.getByRole('button', { name: new RegExp(`^${section.label}`) })).toBeInTheDocument()
    }
  })

  it('shows capability-gated sections only when the backend advertises them', () => {
    const v2 = renderIndex()
    expect(screen.queryByRole('button', { name: /^Plugins/ })).toBeNull()
    v2.unmount()

    renderIndex(['api.plugins'])
    expect(screen.getByRole('button', { name: /^Plugins/ })).toBeInTheDocument()
  })

  it('hides desktop-only sections outside the desktop app', () => {
    renderIndex()
    expect(screen.queryByRole('button', { name: /^Network access/ })).toBeNull()
  })

  it('opens the section that was tapped', async () => {
    const selected: TopLevelSection[] = []
    renderIndex([], (section) => { selected.push(section) })
    await userEvent.click(screen.getByRole('button', { name: /^Providers/ }))
    expect(selected).toEqual(['providers'])
  })
})
