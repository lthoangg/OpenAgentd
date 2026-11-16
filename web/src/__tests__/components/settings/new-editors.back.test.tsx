/**
 * New skill and New connector: Back with something typed asks before the
 * form is thrown away, as the editors of an existing skill or connector do.
 * Wired as the Settings modal wires them: Back sets the list's section.
 */
import { afterEach, describe, expect, it } from 'bun:test'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { ReactNode } from 'react'

import { NewSkillPage } from '@/components/settings/pages/settings.skills.new'
import { NewConnectorPage } from '@/components/settings/pages/settings.connectors.new'
import { useSettingsStore, type SettingsSection } from '@/stores/useSettingsStore'

afterEach(() => {
  cleanup()
  useSettingsStore.setState({ open: false, section: 'general', selectedName: null, dirtyDrafts: {}, pendingNavigation: null })
})

function withClient(children: ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  return render(<QueryClientProvider client={client}>{children}</QueryClientProvider>)
}

const back = (list: SettingsSection) => () => useSettingsStore.getState().setSection(list)

describe('Back from a new editor', () => {
  it('asks before leaving a new skill with edits, and stays on it', () => {
    useSettingsStore.setState({ open: true, section: 'skills-new' })
    withClient(<NewSkillPage onBack={back('skills')} onCreated={() => {}} />)
    fireEvent.change(screen.getByRole('textbox'), { target: { value: '---\nname: mine\ndescription: x\n---\nDo it.' } })

    fireEvent.click(screen.getByRole('button', { name: 'Back to list' }))

    expect(useSettingsStore.getState().section).toBe('skills-new')
    expect(useSettingsStore.getState().pendingNavigation).toEqual({ section: 'skills', name: null })
  })

  it('asks before leaving a new connector with an address typed', () => {
    useSettingsStore.setState({ open: true, section: 'connectors-new' })
    withClient(<NewConnectorPage onBack={back('connectors')} onCreated={() => {}} />)
    fireEvent.change(screen.getByRole('textbox', { name: /^Address/ }), { target: { value: 'https://mcp.example.com' } })

    fireEvent.click(screen.getByRole('button', { name: 'Back to list' }))

    expect(useSettingsStore.getState().section).toBe('connectors-new')
    expect(useSettingsStore.getState().pendingNavigation).toEqual({ section: 'connectors', name: null })
  })

  it('goes straight back when nothing was typed', () => {
    useSettingsStore.setState({ open: true, section: 'connectors-new' })
    withClient(<NewConnectorPage onBack={back('connectors')} onCreated={() => {}} />)

    fireEvent.click(screen.getByRole('button', { name: 'Back to list' }))

    expect(useSettingsStore.getState().section).toBe('connectors')
    expect(useSettingsStore.getState().pendingNavigation).toBeNull()
  })
})
