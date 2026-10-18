import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { NetworkAccessStatus } from '@/lib/app-network-access'

const calls: Array<{ command: string; args: unknown }> = []
let status: NetworkAccessStatus
let failSet: string | null = null

function base(overrides: Partial<NetworkAccessStatus> = {}): NetworkAccessStatus {
  return {
    enabled: false,
    requested_port: 4082,
    port: null,
    fallback: false,
    listening: false,
    error: null,
    lan_urls: [],
    has_key: false,
    sidecar_running: true,
    ...overrides,
  }
}

const listening = (overrides: Partial<NetworkAccessStatus> = {}) =>
  base({ enabled: true, port: 4082, listening: true, has_key: true, lan_urls: ['http://192.168.1.20:4082'], ...overrides })

const invokeMock = mock(async (...args: unknown[]) => {
  const command = String(args[0])
  calls.push({ command, args: args[1] })
  if (command === 'app_network_access_status') return status
  if (command === 'app_set_network_access') {
    if (failSet) throw failSet
    const { enabled } = args[1] as { enabled: boolean; port: number }
    status = enabled ? listening() : base()
    return status
  }
  if (command === 'app_network_access_key') return 'generated-key-0123456789abcdef'
  if (command === 'app_set_network_access_key') return status
  throw new Error(`unexpected command: ${command}`)
})

mock.module('@tauri-apps/api/core', () => ({ invoke: invokeMock }))

const encoded: string[] = []
mock.module('uqr', () => ({
  encode: (value: string) => {
    encoded.push(value)
    return { data: [[true, false], [false, true]] }
  },
}))

const { NetworkAccessCard, firewallHint } = await import('@/components/NetworkAccessCard')
const { parseConnectLink } = await import('@/lib/connect-link')

describe('firewallHint', () => {
  it('points Windows users at the Private network profile', () => {
    expect(firewallHint('windows', 4082)).toContain('Private network')
  })

  it('gives Linux users the command for the listening port', () => {
    const hint = firewallHint('linux', 4083) ?? ''
    expect(hint).toContain('sudo ufw allow 4083/tcp')
    expect(hint).toContain('firewall-cmd --add-port=4083/tcp')
  })

  it('has nothing for mobile platforms', () => {
    expect(firewallHint('ios', 4082)).toBeNull()
  })
})

describe('NetworkAccessCard', () => {
  beforeEach(() => {
    calls.length = 0
    encoded.length = 0
    status = base()
    failSet = null
  })
  afterEach(() => cleanup())

  it('turns network access on with the preferred port and shows the address', async () => {
    render(<NetworkAccessCard />)
    const toggle = await screen.findByRole('switch', { name: /allow devices on your network/i })
    await waitFor(() => expect((toggle as HTMLButtonElement).disabled).toBe(false))
    await userEvent.click(toggle)

    await waitFor(() => expect(calls.some((c) => c.command === 'app_set_network_access')).toBe(true))
    expect(calls.find((c) => c.command === 'app_set_network_access')?.args).toEqual({ enabled: true, port: 4082 })
    expect(await screen.findByText('http://192.168.1.20:4082')).toBeTruthy()
    expect(screen.getByRole('switch').getAttribute('aria-checked')).toBe('true')
  })

  it('keeps the key masked until shown', async () => {
    status = listening()
    render(<NetworkAccessCard />)
    const key = await screen.findByTestId('network-access-key')
    expect(key.textContent).not.toContain('generated-key')
    expect(calls.some((c) => c.command === 'app_network_access_key')).toBe(false)

    await userEvent.click(screen.getByRole('button', { name: 'show' }))
    await waitFor(() => expect(screen.getByTestId('network-access-key').textContent).toBe('generated-key-0123456789abcdef'))
  })

  it('regenerates the key', async () => {
    status = listening()
    render(<NetworkAccessCard />)
    await userEvent.click(await screen.findByRole('button', { name: 'regenerate' }))
    await waitFor(() => expect(calls.find((c) => c.command === 'app_set_network_access_key')?.args).toEqual({ key: null }))
  })

  it('explains a port fallback', async () => {
    status = listening({ port: 4083, fallback: true, lan_urls: ['http://192.168.1.20:4083'] })
    render(<NetworkAccessCard />)
    expect(await screen.findByText('Port 4082 was in use; listening on 4083.')).toBeTruthy()
  })

  it('shows a failure inline and leaves the switch off', async () => {
    failSet = 'credential store unavailable'
    render(<NetworkAccessCard />)
    const toggle = await screen.findByRole('switch')
    await waitFor(() => expect((toggle as HTMLButtonElement).disabled).toBe(false))
    await userEvent.click(toggle)
    expect((await screen.findByRole('alert')).textContent).toContain('credential store unavailable')
    expect(screen.getByRole('switch').getAttribute('aria-checked')).toBe('false')
  })

  it('is disabled while the builtin backend is stopped', async () => {
    status = base({ sidecar_running: false })
    render(<NetworkAccessCard />)
    expect(await screen.findByText('Start the builtin backend first.')).toBeTruthy()
    expect((screen.getByRole('switch') as HTMLButtonElement).disabled).toBe(true)
  })

  it('shows a QR with every address and the key only on request', async () => {
    status = listening({ lan_urls: ['http://192.168.1.20:4082', 'http://10.0.0.5:4082'] })
    render(<NetworkAccessCard />)
    await userEvent.click(await screen.findByRole('button', { name: 'show QR' }))

    expect(await screen.findByRole('img', { name: 'Connection QR code' })).toBeTruthy()
    expect(calls.some((c) => c.command === 'app_network_access_key')).toBe(true)
    expect(parseConnectLink(encoded.at(-1) ?? '')).toEqual({
      urls: ['http://192.168.1.20:4082', 'http://10.0.0.5:4082'],
      key: 'generated-key-0123456789abcdef',
    })

    await userEvent.click(screen.getByRole('button', { name: 'hide QR' }))
    expect(screen.queryByRole('img', { name: 'Connection QR code' })).toBeNull()
  })

  it('does not fetch the key or show a QR by default', async () => {
    status = listening()
    render(<NetworkAccessCard />)
    await screen.findByRole('button', { name: 'show QR' })
    expect(screen.queryByRole('img', { name: 'Connection QR code' })).toBeNull()
    expect(calls.some((c) => c.command === 'app_network_access_key')).toBe(false)
  })

  it('hides the QR when the key is regenerated', async () => {
    status = listening()
    render(<NetworkAccessCard />)
    await userEvent.click(await screen.findByRole('button', { name: 'show QR' }))
    await screen.findByRole('img', { name: 'Connection QR code' })
    await userEvent.click(screen.getByRole('button', { name: 'regenerate' }))
    await waitFor(() => expect(screen.queryByRole('img', { name: 'Connection QR code' })).toBeNull())
  })

  it('disables the QR without a LAN address', async () => {
    status = listening({ lan_urls: [] })
    render(<NetworkAccessCard />)
    expect((await screen.findByRole('button', { name: 'show QR' }) as HTMLButtonElement).disabled).toBe(true)
  })
})
