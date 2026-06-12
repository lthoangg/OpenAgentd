import { beforeEach, describe, expect, it, mock } from 'bun:test'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { ReactNode } from 'react'

const mockSendDesktopNotification = mock(() => Promise.resolve({ status: 'sent', message: 'Native notification sent.' }))
let enabled = true

mock.module('@tanstack/react-router', () => ({
  Link: ({ children }: { children: ReactNode }) => children,
}))

mock.module('@/hooks/use-mobile', () => ({
  useIsMobile: () => false,
}))

let soundEnabled = true

mock.module('@/lib/desktop-notifications', () => ({
  areDesktopNotificationSoundsEnabled: () => soundEnabled,
  areDesktopNotificationsEnabled: () => enabled,
  setDesktopNotificationSoundsEnabled: (next: boolean) => { soundEnabled = next },
  setDesktopNotificationsEnabled: (next: boolean) => { enabled = next },
  sendDesktopNotification: mockSendDesktopNotification,
}))

import { NotificationSettingsPage } from '@/routes/settings.notifications'

beforeEach(() => {
  enabled = true
  soundEnabled = true
  mockSendDesktopNotification.mockReset()
  mockSendDesktopNotification.mockImplementation(() => Promise.resolve({ status: 'sent', message: 'Native notification sent.' }))
})

describe('NotificationSettingsPage', () => {
  it('keeps notification controls touch-sized before desktop compact sizing', () => {
    render(<NotificationSettingsPage />)

    const enabledSwitch = screen.getByRole('switch', { name: /enabled/i })
    expect(enabledSwitch.parentElement?.className).toContain('min-h-11')
    expect(enabledSwitch.parentElement?.className).toContain('md:min-h-0')

    const soundSwitch = screen.getByRole('switch', { name: /play sound/i })
    expect(soundSwitch.parentElement?.className).toContain('min-h-11')
    expect(soundSwitch.parentElement?.className).toContain('md:min-h-0')

    const testButton = screen.getByRole('button', { name: /send test notification/i })
    expect(testButton.className).toContain('min-h-11')
    expect(testButton.className).toContain('md:min-h-0')
  })

  it('toggles app notifications', async () => {
    render(<NotificationSettingsPage />)

    await userEvent.click(screen.getByRole('switch', { name: /enabled/i }))

    expect(enabled).toBe(false)
    expect(screen.getByRole('button', { name: /send test notification/i }).hasAttribute('disabled')).toBe(true)
  })

  it('toggles notification sound', async () => {
    render(<NotificationSettingsPage />)

    await userEvent.click(screen.getByRole('switch', { name: /play sound/i }))

    expect(soundEnabled).toBe(false)
  })

  it('sends only a forced native test notification', async () => {
    render(<NotificationSettingsPage />)

    await userEvent.click(screen.getByRole('button', { name: /send test notification/i }))

    expect(mockSendDesktopNotification).toHaveBeenCalledWith(
      {
        kind: 'assistant_done',
        title: 'OpenAgentd notification test',
        body: 'App notifications are working.',
      },
      { force: true },
    )
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /send test notification/i }).textContent).toContain('Send test notification')
    })
    expect(screen.getByText('Native notification sent.')).toBeTruthy()
    expect(screen.queryByText('Test notification sent')).toBeNull()
    expect(screen.queryByText('Test notification not sent')).toBeNull()
  })

  it('shows native notification failure diagnostics', async () => {
    mockSendDesktopNotification.mockImplementation(() => Promise.resolve({
      status: 'permission-denied',
      message: 'OS notification permission was not granted.',
    }))
    render(<NotificationSettingsPage />)

    await userEvent.click(screen.getByRole('button', { name: /send test notification/i }))

    await waitFor(() => {
      expect(screen.getByText('OS notification permission was not granted.')).toBeTruthy()
    })
  })
})
