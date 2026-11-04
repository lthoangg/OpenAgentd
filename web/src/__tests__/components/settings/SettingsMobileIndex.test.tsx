/**
 * The phone landing view of Settings: every visible section, grouped.
 */
import '@testing-library/jest-dom'

import { afterEach, describe, expect, it } from 'bun:test'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

import { queryKeys } from '@/queries'
import { SETTINGS_GROUPS, SETTINGS_SECTIONS, type TopLevelSection } from '@/components/settings/sections'
import { SettingsMobileIndex } from '@/components/settings/SettingsMobileIndex'
import type { SettingsHit } from '@/components/settings/settings-index'

const originalFetch = globalThis.fetch

function renderIndex(
  capabilities: string[] = [],
  onSelect: (section: TopLevelSection) => void = () => {},
  onOpenHit?: (hit: SettingsHit) => void,
) {
  globalThis.fetch = (() => Promise.reject(new Error('network disabled in test'))) as unknown as typeof fetch
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Number.POSITIVE_INFINITY } },
  })
  queryClient.setQueryData(queryKeys.health(), { status: 'ok', version: '3.0.0', capabilities })
  return render(
    <QueryClientProvider client={queryClient}>
      <SettingsMobileIndex onSelect={onSelect} onOpenHit={onOpenHit} />
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

  it('describes Plugins by what they bring: skills, MCP servers and tools', () => {
    renderIndex(['api.plugins'])
    expect(screen.getByRole('button', { name: /^Plugins/ })).toHaveTextContent('Skills, MCP servers and tools from plugins')
  })

  it('opens the section that was tapped', async () => {
    const selected: TopLevelSection[] = []
    renderIndex([], (section) => { selected.push(section) })
    await userEvent.click(screen.getByRole('button', { name: /^Providers/ }))
    expect(selected).toEqual(['providers'])
  })

  describe('search', () => {
    it('has a search field on the phone, above the sections', () => {
      renderIndex()
      expect(screen.getByRole('searchbox', { name: 'Search settings' })).toBeInTheDocument()
    })

    it('lists matching sections and single settings instead of the groups', async () => {
      renderIndex()
      await userEvent.type(screen.getByRole('searchbox', { name: 'Search settings' }), 'text size')
      const results = within(screen.getByRole('list', { name: 'Search results' }))
      expect(results.getByRole('button', { name: 'Text size, in Appearance' })).toBeInTheDocument()
      // The section list gives way to the results.
      expect(screen.queryByRole('heading', { name: 'Models and media' })).toBeNull()
    })

    it('opens the setting that was tapped, in its section', async () => {
      const hits: SettingsHit[] = []
      renderIndex([], () => {}, (hit) => { hits.push(hit) })
      await userEvent.type(screen.getByRole('searchbox', { name: 'Search settings' }), 'fallback')
      await userEvent.click(screen.getByRole('button', { name: 'Accounts and fallback order, in Providers' }))
      expect(hits).toHaveLength(1)
      expect(hits[0]).toMatchObject({ kind: 'setting', section: 'providers', label: 'Accounts and fallback order' })
    })

    it('opens just the section when no handler for results is given', async () => {
      const selected: TopLevelSection[] = []
      renderIndex([], (section) => { selected.push(section) })
      await userEvent.type(screen.getByRole('searchbox', { name: 'Search settings' }), 'fallback')
      await userEvent.click(screen.getByRole('button', { name: 'Accounts and fallback order, in Providers' }))
      expect(selected).toEqual(['providers'])
    })

    it('says when nothing matches, and brings the groups back when cleared', async () => {
      renderIndex()
      const search = screen.getByRole('searchbox', { name: 'Search settings' })
      await userEvent.type(search, 'zzz')
      expect(screen.getByText('No settings match “zzz”.')).toBeInTheDocument()
      await userEvent.clear(search)
      expect(screen.getByRole('heading', { name: 'Models and media' })).toBeInTheDocument()
    })
  })
})
