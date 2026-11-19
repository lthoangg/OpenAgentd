/**
 * Settings → Desktop → Startup: "Open at login". The OS holds the state, so
 * the switch shows what the shell reads back, not what was asked for.
 */
import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import '@testing-library/jest-dom'

let enabled: boolean | null = false
let asked: boolean[] = []
let failWith: string | null = null
/** False: the OS does not keep the entry it was asked to add. */
let keeps = true
let os = 'macos'

mock.module('@/lib/autostart-setting', () => ({
  readAutostart: async () => enabled,
  setAutostart: async (want: boolean) => {
    asked.push(want)
    if (failWith) throw new Error(failWith)
    enabled = keeps ? want : enabled
    return enabled
  },
}))
mock.module('@/hooks/use-platform', () => ({
  getPlatform: () => ({ isTauri: true, os, isMacOverlay: os === 'macos' }),
  usePlatform: () => ({ isTauri: true, os, isMacOverlay: os === 'macos' }),
}))

const { StartupSection } = await import('@/components/settings/StartupSection')

const toggle = () => screen.findByRole('switch', { name: 'Open at login' })

beforeEach(() => {
  enabled = false
  asked = []
  failWith = null
  keeps = true
  os = 'macos'
})
afterEach(cleanup)

describe('StartupSection', () => {
  it('shows what the system has: off until it is turned on', async () => {
    render(<StartupSection />)
    expect(await toggle()).toHaveAttribute('aria-checked', 'false')
  })

  it('shows it on when the login entry already exists', async () => {
    enabled = true
    render(<StartupSection />)
    expect(await toggle()).toHaveAttribute('aria-checked', 'true')
  })

  it('turns it on at once and asks the shell once', async () => {
    render(<StartupSection />)
    fireEvent.click(await toggle())
    await waitFor(() => expect(asked).toEqual([true]))
    expect(await toggle()).toHaveAttribute('aria-checked', 'true')
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('goes back and says why when the system refuses', async () => {
    failWith = 'A development build does not open at login. Install OpenAgentd to use this.'
    render(<StartupSection />)
    fireEvent.click(await toggle())
    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent("Couldn't change Open at login")
    expect(alert).toHaveTextContent('A development build does not open at login.')
    expect(await toggle()).toHaveAttribute('aria-checked', 'false')
  })

  it('shows what the system answered, not what was asked', async () => {
    keeps = false
    render(<StartupSection />)
    fireEvent.click(await toggle())
    await waitFor(() => expect(asked).toEqual([true]))
    await waitFor(() => expect(screen.getByRole('switch', { name: 'Open at login' })).toHaveAttribute('aria-checked', 'false'))
  })

  it('says where to open the app from, in the words of this system', async () => {
    render(<StartupSection />)
    await toggle()
    expect(screen.getByText(/Open it from the Dock or the menu bar\./)).toBeInTheDocument()
    cleanup()

    os = 'windows'
    render(<StartupSection />)
    await toggle()
    expect(screen.getByText(/Open it from the taskbar or the tray\./)).toBeInTheDocument()
    cleanup()

    os = 'linux'
    render(<StartupSection />)
    await toggle()
    expect(screen.getByText(/Open it from the launcher or the tray\./)).toBeInTheDocument()
  })

  it('draws nothing in a shell that cannot say (an older app)', async () => {
    enabled = null
    const { container } = render(<StartupSection />)
    await waitFor(() => expect(screen.queryByRole('status')).toBeNull())
    expect(container).toBeEmptyDOMElement()
  })
})
