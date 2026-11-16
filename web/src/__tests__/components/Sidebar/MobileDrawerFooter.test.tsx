import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import { screen } from '@testing-library/react'
import { cleanupSidebarHarness, fx, renderSidebarWithProps, resetSidebarHarness } from './harness'

describe('Sidebar workspace trust flow', () => {
  beforeEach(resetSidebarHarness)
  afterEach(cleanupSidebarHarness)

  it('renders labelled Settings and Usage in the mobile sidebar footer, but no search bar', async () => {
    fx.isMobile = true
    const onMobileClose = mock(() => {})

    await renderSidebarWithProps({ mobileOpen: true, onMobileClose })

    expect(screen.getAllByRole('button', { name: 'Usage' })).toHaveLength(1)
    expect(screen.getAllByRole('button', { name: 'Settings' })).toHaveLength(1)
    expect(screen.queryByRole('button', { name: 'Open Quick Open' })).toBeNull()
  })

  it('names the connected server in the mobile sidebar footer', async () => {
    fx.isMobile = true

    await renderSidebarWithProps({ mobileOpen: true })

    expect(screen.getByRole('button', { name: 'Connected. Change computer' }).textContent).toBe('backend-name')
  })

  it('has no help button that opens the command palette under another name', async () => {
    fx.isMobile = true

    await renderSidebarWithProps({ mobileOpen: true })

    expect(screen.queryByRole('button', { name: 'Help and shortcuts' })).toBeNull()
  })
})
