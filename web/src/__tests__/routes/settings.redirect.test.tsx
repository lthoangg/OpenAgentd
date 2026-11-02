/**
 * /settings and /settings/<section> are deep-link shims: they open the
 * Settings modal (on that section when it is one) and hand the URL back to
 * the workspace, instead of reading "settings" as a session id.
 */
import { afterEach, describe, expect, it, mock } from 'bun:test'
import { cleanup, render } from '@testing-library/react'

const navigate = mock(() => Promise.resolve())
let params: Record<string, unknown> = {}
mock.module('@tanstack/react-router', () => ({
  useNavigate: () => navigate,
  useParams: () => params,
}))

import { SettingsPage } from '@/routes/settings'
import { useSettingsStore } from '@/stores/useSettingsStore'

afterEach(() => {
  cleanup()
  navigate.mockClear()
  params = {}
  useSettingsStore.setState({ open: false, section: 'general' })
})

describe('/settings', () => {
  it('opens Settings where it was left, then goes to /', () => {
    useSettingsStore.setState({ section: 'memory' })
    render(<SettingsPage />)
    expect(useSettingsStore.getState()).toMatchObject({ open: true, section: 'memory' })
    expect(navigate).toHaveBeenCalledWith({ to: '/', replace: true })
  })

  it('opens the linked section', () => {
    params = { section: 'providers' }
    render(<SettingsPage />)
    expect(useSettingsStore.getState()).toMatchObject({ open: true, section: 'providers' })
  })

  it('ignores a section Settings does not have', () => {
    useSettingsStore.setState({ section: 'memory' })
    params = { section: 'nope' }
    render(<SettingsPage />)
    expect(useSettingsStore.getState()).toMatchObject({ open: true, section: 'memory' })
  })
})
