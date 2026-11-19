/**
 * Settings → Desktop → Startup (desktop app): "Open at login". The app then
 * starts in the background when the person signs in to the computer, with
 * no window, so scheduled tasks run and the account's other devices can
 * reach it. The switch shows what the system has, read back after each
 * change; the shell stores nothing of its own.
 */
import { useEffect, useState } from 'react'

import { Callout } from '@/components/ui/callout'
import { PanelRow } from '@/components/ui/panel-row'
import { PanelSection } from '@/components/ui/panel-section'
import { Skeleton } from '@/components/ui/skeleton'
import { Switch } from '@/components/ui/switch'
import { getPlatform } from '@/hooks/use-platform'
import { readAutostart, setAutostart } from '@/lib/autostart-setting'

/** Where a background app is opened from, in the system's own words. */
function openFrom(os: string): string {
  if (os === 'macos') return 'the Dock or the menu bar'
  if (os === 'windows') return 'the taskbar or the tray'
  return 'the launcher or the tray'
}

export function StartupSection() {
  // undefined: not read yet. null: this app cannot say (an older shell).
  const [enabled, setEnabled] = useState<boolean | null | undefined>(undefined)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    void readAutostart().then((value) => {
      if (!cancelled) setEnabled(value)
    })
    return () => {
      cancelled = true
    }
  }, [])

  if (enabled === null) return null
  if (enabled === undefined) {
    return (
      <PanelSection title="Startup" flush>
        <div role="status" aria-label="Loading startup settings" className="space-y-2 px-4 py-3">
          <Skeleton className="h-4 w-1/3" />
          <Skeleton className="h-4 w-2/3" />
        </div>
      </PanelSection>
    )
  }

  const change = (want: boolean) => {
    const previous = enabled
    setEnabled(want)
    setError(null)
    setSaving(true)
    setAutostart(want)
      .then(setEnabled, (err: unknown) => {
        setEnabled(previous)
        setError(err instanceof Error ? err.message : String(err))
      })
      .finally(() => setSaving(false))
  }

  return (
    <PanelSection title="Startup" flush>
      {error && (
        <div className="px-4 py-3">
          <Callout tone="error" role="alert" title="Couldn't change Open at login">{error}</Callout>
        </div>
      )}
      <PanelRow
        label="Open at login"
        htmlFor="open-at-login"
        description={`OpenAgentd starts in the background when you sign in to this computer, so scheduled tasks run and your other devices can reach it. Open it from ${openFrom(getPlatform().os)}.`}
      >
        <Switch id="open-at-login" checked={enabled} disabled={saving} onCheckedChange={change} />
      </PanelRow>
    </PanelSection>
  )
}
