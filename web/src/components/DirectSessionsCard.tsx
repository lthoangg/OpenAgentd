/**
 * DirectSessionsCard — Settings → Server switch for direct sessions: the
 * account's devices reach this computer on the home network with their
 * account keys instead of through the relay. Shown only while this
 * computer is in an account as a server. It is not network access (the
 * access key) and shares nothing with it.
 */
import { useEffect, useState } from 'react'

import { getDirectSetting, setDirectSetting, type DirectSetting } from '@/api/cloud'
import { Callout } from '@/components/ui/callout'
import { PanelRow } from '@/components/ui/panel-row'
import { PanelSection } from '@/components/ui/panel-section'
import { Switch } from '@/components/ui/switch'
import { TEXT } from '@/components/settings/tokens'
import { getPlatform, type OS } from '@/hooks/use-platform'
import { cn } from '@/lib/utils'
import { useCloudStatusQuery } from '@/queries/cloud'

/** What the OS may ask the first time, per platform. */
export function directFirewallNote(os: OS): string | null {
  if (os === 'macos') return 'If the macOS firewall is on, macOS asks once to accept incoming connections. Allow it, or devices use your account instead.'
  if (os === 'windows') return 'Windows asks once to allow OpenAgentd on private networks. If it\u2019s refused, devices use your account instead.'
  return null
}

export function DirectSessionsCard() {
  const status = useCloudStatusQuery().data
  const server = status?.state === 'connected' && status.server !== false
  const [setting, setSetting] = useState<DirectSetting | null>(null)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!server) return
    let cancelled = false
    getDirectSetting()
      .then((next) => { if (!cancelled) setSetting(next) })
      .catch((err: unknown) => { if (!cancelled) setError(err instanceof Error ? err.message : 'Couldn\u2019t read the setting.') })
    return () => { cancelled = true }
  }, [server])

  if (!server) return null

  function toggle(on: boolean) {
    setPending(true)
    setError(null)
    setDirectSetting(on)
      .then(setSetting)
      .catch((err: unknown) => setError(err instanceof Error ? err.message : 'Couldn\u2019t change the setting.'))
      .finally(() => setPending(false))
  }

  const note = directFirewallNote(getPlatform().os)
  const description = setting?.on
    ? setting.port
      ? `Only devices in your account can connect, with their account keys. Listening on port ${setting.port}.`
      : 'Only devices in your account can connect, with their account keys. Waiting for a local network.'
    : 'Your devices connect through your account.'

  return (
    <PanelSection title="Your account's devices" flush>
      <PanelRow
        label="Let your account's devices connect directly on this network"
        labelId="direct-sessions-label"
        description={description}
      >
        <Switch
          aria-labelledby="direct-sessions-label"
          checked={setting?.on ?? false}
          onCheckedChange={toggle}
          disabled={pending || !setting}
        />
      </PanelRow>
      {setting?.on && note ? <p className={cn('px-4 pb-3', TEXT.hint)}>{note}</p> : null}
      {error ? (
        <div className="px-4 py-3">
          <Callout tone="error" role="alert">{error}</Callout>
        </div>
      ) : null}
    </PanelSection>
  )
}
