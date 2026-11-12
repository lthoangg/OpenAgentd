/**
 * "Copy diagnostics" on the phone's Servers screen: the shell's last
 * connection events as plain text, with the app version and the time, for
 * the person to paste into a report.
 */
import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'

const realPlatform = await import('@/hooks/use-platform')
const phone = { isTauri: true, os: 'ios', isMacOverlay: false, isFullscreen: false }
mock.module('@/hooks/use-platform', () => ({ ...realPlatform, getPlatform: () => phone, usePlatform: () => phone }))
mock.module('@tauri-apps/api/app', () => ({ getVersion: async () => '3.53.1' }))

const at = new Date(2025, 10, 12, 18, 41, 7).getTime()
mock.module('@tauri-apps/api/core', () => ({
  invoke: async (command: string) => {
    if (command === 'cloud_diagnostics') {
      return [
        { at_ms: at, text: 'app back' },
        { at_ms: at, text: 'bridge 9C02 E1B7: not answering' },
        { at_ms: at + 1000, text: 'link 9C02 E1B7: up, through your account' },
      ]
    }
    throw new Error(`unexpected command: ${command}`)
  },
}))

const { ConnectionDiagnosticsRow } = await import('@/components/phone/ConnectionDiagnostics')
const { diagnosticsText } = await import('@/lib/connection-diagnostics')

let copied: string[] = []
const realClipboard = navigator.clipboard

beforeEach(() => {
  copied = []
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: { writeText: async (text: string) => { copied.push(text) } },
  })
})

afterEach(() => {
  cleanup()
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: realClipboard })
})

describe('connection diagnostics', () => {
  it('reads as a header with the version and time, then one line per event', () => {
    const text = diagnosticsText(
      [{ at_ms: at, text: 'app back' }, { at_ms: at + 1000, text: 'link 9C02 E1B7: connecting' }],
      { version: '3.53.1', platform: 'iOS', now: new Date(2025, 10, 12, 18, 42, 0) },
    )
    expect(text).toBe(['OpenAgentd 3.53.1 (iOS) · 12 Nov 18:42', '18:41:07  app back', '18:41:08  link 9C02 E1B7: connecting'].join('\n'))
  })

  it('copies them from one row and says Copied', async () => {
    render(<ConnectionDiagnosticsRow />)
    const row = screen.getByRole('button', { name: 'Copy diagnostics' })
    await act(async () => { fireEvent.click(row) })
    expect(copied).toHaveLength(1)
    expect(copied[0].split('\n')[0]).toMatch(/^OpenAgentd 3\.53\.1 \(iOS\) · \d{1,2} \w{3} \d{2}:\d{2}$/)
    expect(copied[0]).toContain('18:41:07  bridge 9C02 E1B7: not answering')
    expect(copied[0]).toContain('18:41:08  link 9C02 E1B7: up, through your account')
    expect(screen.getByText('Copied')).toBeTruthy()
  })
})
