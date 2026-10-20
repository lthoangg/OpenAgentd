/**
 * Settings → Network access (desktop only) — let phones and other computers
 * on the LAN connect to the builtin backend with an access key.
 */
import { NetworkAccessCard } from '@/components/NetworkAccessCard'
import { SettingsPage } from '@/components/settings/SettingsPage'

export function NetworkSettingsPage() {
  return (
    <SettingsPage
      title="Network access"
      description="Use this computer's agents from your phone or another computer on the same network."
    >
      <NetworkAccessCard title="Access" />
    </SettingsPage>
  )
}
