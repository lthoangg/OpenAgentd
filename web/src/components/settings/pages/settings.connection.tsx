/**
 * Settings → Connection — which OpenAgentd backend this app talks to, and
 * (desktop) whether other devices may connect to the builtin one.
 */
import { AppBackendPanel } from '@/components/AppBackendPanel'
import { SettingsPage } from '@/components/settings/SettingsPage'

export function ConnectionSettingsPage() {
  return (
    <SettingsPage
      title="Connection"
      description="Use the builtin backend that runs inside this app, or a server you run elsewhere."
    >
      <AppBackendPanel active />
    </SettingsPage>
  )
}
