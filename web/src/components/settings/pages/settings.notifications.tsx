/**
 * Notifications — desktop/mobile notification preference.
 *
 * Previously the only settings page that wrote on interaction: flipping the
 * Switch called `setDesktopNotificationsEnabled` immediately, with no Save and
 * no confirmation. Every other page required Save, so the surface taught two
 * contradictory rules. It now uses the same draft + save bar as the rest.
 */
import { useState } from 'react'
import { Bell, BellRing } from 'lucide-react'

import {
  areDesktopNotificationsEnabled,
  sendDesktopNotification,
  setDesktopNotificationsEnabled,
} from '@/lib/desktop-notifications'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import { SettingsSection } from '@/components/settings/SettingsSection'
import { SettingsPage } from '@/components/settings/SettingsPage'
import { useSettingsDraft } from '@/components/settings/useSettingsDraft'
import { TEXT } from '@/components/settings/tokens'

interface NotificationForm {
  enabled: boolean
}

export function NotificationSettingsPage() {
  // Read once on mount. localStorage is the source of truth here, so the
  // snapshot only changes when we write it back on save.
  const [stored, setStored] = useState<NotificationForm>(() => ({
    enabled: areDesktopNotificationsEnabled(),
  }))
  const [testing, setTesting] = useState(false)
  const [testMessage, setTestMessage] = useState<string | null>(null)

  const draft = useSettingsDraft<NotificationForm>({
    data: stored,
    initial: stored,
    onSave: async (value) => {
      setDesktopNotificationsEnabled(value.enabled)
      setStored(value)
      return value
    },
    successTitle: 'Notification settings saved',
  })

  const handleTest = async () => {
    setTesting(true)
    setTestMessage(null)
    try {
      const result = await sendDesktopNotification(
        {
          kind: 'assistant_done',
          title: 'OpenAgentd notification test',
          body: 'App notifications are working.',
        },
        { force: true },
      )
      setTestMessage(result.message)
    } finally {
      setTesting(false)
    }
  }

  return (
    <SettingsPage
      title="Notifications"
      icon={Bell}
      draft={draft}
      intro="App notifications appear when OpenAgentd is running in a Tauri desktop or mobile app. Desktop notifications are skipped while the app window is focused."
    >
      <SettingsSection title="Status">
        <div className="space-y-3">
          <label className="flex min-h-11 cursor-pointer items-center gap-3 text-xs select-none md:min-h-0">
            <Switch
              checked={draft.value.enabled}
              onCheckedChange={(checked) => draft.patch({ enabled: checked })}
            />
            <span className={TEXT.label}>Enabled</span>
          </label>
          <p className={TEXT.hint}>
            OpenAgentd will notify you when an assistant finishes responding,
            a background task completes, or a reminder fires. Notifications
            are skipped while the app window is focused.
          </p>
          <p className={TEXT.subtle}>
            Notification sounds are controlled by your operating system. OpenAgentd does not play an extra in-app sound.
          </p>
        </div>
      </SettingsSection>

      <SettingsSection title="Test" description="send a test notification now">
        <div className="space-y-3">
          <p className={TEXT.hint}>
            Send one notification now to confirm OS permissions and native
            app integration are working.
          </p>
          <Button
            size="sm"
            className="min-h-11 md:min-h-0"
            onClick={handleTest}
            disabled={!stored.enabled || testing}
          >
            <BellRing size={12} aria-hidden="true" />
            {testing ? 'Sending…' : 'Send test notification'}
          </Button>
          {!stored.enabled && draft.value.enabled && (
            <p className={TEXT.subtle} role="status">
              Save first to enable notifications, then send a test.
            </p>
          )}
          {testMessage && (
            <p className="font-mono text-[11px] text-(--color-text-subtle)" role="status">
              {testMessage}
            </p>
          )}
        </div>
      </SettingsSection>
    </SettingsPage>
  )
}
