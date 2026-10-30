/**
 * Settings → Connection — which OpenAgentd server this app talks to and, in
 * the desktop app, whether phones and other computers may connect to the
 * built-in one (formerly its own Network access page).
 */
import { AppBackendPanel } from '@/components/AppBackendPanel'
import { NetworkAccessCard } from '@/components/NetworkAccessCard'
import { SettingsPage } from '@/components/settings/SettingsPage'
import { isDesktopShell } from '@/lib/desktop-shell'

export function ConnectionSettingsPage() {
  return (
    <SettingsPage
      title="Connection"
      description="Use the built-in server that runs inside this app, or a server you run elsewhere."
    >
      <AppBackendPanel active />
      {isDesktopShell() && <NetworkAccessCard title="Access from other devices" />}
    </SettingsPage>
  )
}
