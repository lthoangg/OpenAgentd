import { describe, expect, it, mock } from 'bun:test'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { TrayPopup } from '@/tray/TrayPopup'
import type { TrayUsageResult } from '@/tray/usage'

const mockUsageResult: TrayUsageResult = {
  server_name: 'Mac Studio',
  server_id: 'http://192.168.1.10:4082',
  selected_server_id: 'auto',
  servers: [
    { id: 'auto', name: 'Auto (Active Window)', detail: 'Mac Studio' },
    { id: 'bundled', name: 'Local Bundled', detail: null },
    { id: 'http://192.168.1.10:4082', name: 'Mac Studio', detail: '192.168.1.10:4082' },
  ],
  summary: {
    checked_at: 1_700_000_000,
    cached: false,
    items: [
      {
        provider: 'openai',
        label: 'OpenAI Codex',
        status: 'ok',
        stale: false,
        usage: {
          provider: 'openai',
          limits: [
            {
              limit_name: 'Codex',
              primary: { used_percent: 42, window_minutes: 300, resets_at: 1_700_018_000 },
            },
          ],
        },
      },
    ],
  },
}

mock.module('@tauri-apps/api/core', () => ({
  invoke: async (cmd: string, args: Record<string, unknown>) => {
    if (cmd === 'get_tray_usage_summary') {
      if (args?.targetServer === 'bundled') {
        return {
          ...mockUsageResult,
          server_name: 'Local Bundled',
          server_id: 'bundled',
          selected_server_id: 'bundled',
        }
      }
      return mockUsageResult
    }
    return undefined
  },
}))

mock.module('@tauri-apps/api/event', () => ({
  listen: async () => () => {},
}))

describe('TrayPopup component', () => {
  it('renders brand, server name badge, and usage meters', async () => {
    render(<TrayPopup />)
    expect(screen.getByText('OpenAgentd')).toBeDefined()

    await waitFor(() => {
      expect(screen.getByText('Mac Studio')).toBeDefined()
      expect(screen.getByText('42%')).toBeDefined()
    })
  })

  it('opens server dropdown on trigger click and switches server', async () => {
    render(<TrayPopup />)
    await waitFor(() => {
      expect(screen.getByText('Mac Studio')).toBeDefined()
    })

    const trigger = screen.getByTitle('Mac Studio')
    fireEvent.click(trigger)

    expect(screen.getByText('Auto (Active Window)')).toBeDefined()
    expect(screen.getByText('Local Bundled')).toBeDefined()

    const bundledBtn = screen.getByText('Local Bundled')
    fireEvent.click(bundledBtn)

    await waitFor(() => {
      expect(screen.getByTitle('Local Bundled')).toBeDefined()
    })
  })
})
