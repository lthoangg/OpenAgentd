/**
 * Settings → Desktop (desktop app only): the agent status in the notch
 * (macOS) and the desktop pet (macOS and Windows). Each switch saves at
 * once.
 */
import { useEffect, useState } from 'react'

import { SettingsPage } from '@/components/settings/SettingsPage'
import { PetSettingsSection } from '@/components/settings/PetSettingsSection'
import { Callout } from '@/components/ui/callout'
import { PanelRow } from '@/components/ui/panel-row'
import { PanelSection } from '@/components/ui/panel-section'
import { Skeleton } from '@/components/ui/skeleton'
import { Switch } from '@/components/ui/switch'
import { type IslandSettings, readIslandSettings, supportsIsland, updateIslandSettings } from '@/lib/island-setting'
import { supportsPet } from '@/lib/pet-setting'

/** The options under the main switch, in the order they are shown. */
const NOTCH_OPTIONS: ReadonlyArray<{ key: Exclude<keyof IslandSettings, 'enabled'>; label: string; description: string }> = [
  {
    key: 'showWhenFrontmost',
    label: 'Show while OpenAgentd is in front',
    description: 'By default it steps aside while you use the app, whose sidebar shows the same status.',
  },
  {
    key: 'showFinished',
    label: 'Keep finished sessions until opened',
    description: 'Show "Done" (or "Failed") until you open the session or dismiss it.',
  },
  {
    key: 'expandOnHover',
    label: 'Expand on hover',
    description: 'Point at it to list the sessions, their questions and what finished.',
  },
]

/** macOS app only: the agent status pill in the notch. */
function NotchStatusSection() {
  const [settings, setSettings] = useState<IslandSettings | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    void readIslandSettings().then((value) => {
      if (!cancelled) setSettings(value)
    })
    return () => {
      cancelled = true
    }
  }, [])

  if (settings === null) {
    return (
      <PanelSection title="Notch" flush>
        <div role="status" aria-label="Loading notch settings" className="space-y-2 px-4 py-3">
          <Skeleton className="h-4 w-1/2" />
          <Skeleton className="h-4 w-2/3" />
        </div>
      </PanelSection>
    )
  }

  const change = (patch: Partial<IslandSettings>) => {
    const previous = settings
    setSettings({ ...settings, ...patch })
    setError(null)
    updateIslandSettings(patch).then(setSettings, (err: unknown) => {
      setSettings(previous)
      setError(err instanceof Error ? err.message : String(err))
    })
  }

  return (
    <PanelSection title="Notch" flush>
      {error && (
        <div className="px-4 py-3">
          <Callout tone="error" role="alert" title="Couldn't save the notch setting">{error}</Callout>
        </div>
      )}
      <PanelRow
        label="Agent status in the notch"
        htmlFor="island-enabled"
        description="While you work in another app, the notch shows running agents, questions waiting on you, and finished replies."
      >
        <Switch id="island-enabled" checked={settings.enabled} onCheckedChange={(enabled) => change({ enabled })} />
      </PanelRow>
      {NOTCH_OPTIONS.map((option) => (
        <PanelRow
          key={option.key}
          label={option.label}
          htmlFor={`island-${option.key}`}
          description={settings.enabled ? option.description : 'Turn on Agent status to change this.'}
        >
          <Switch
            id={`island-${option.key}`}
            checked={settings[option.key]}
            disabled={!settings.enabled}
            onCheckedChange={(checked) => change({ [option.key]: checked })}
          />
        </PanelRow>
      ))}
    </PanelSection>
  )
}

/** Whether this build has anything to show on the Desktop page. */
export function hasDesktopSettings(): boolean {
  return supportsIsland() || supportsPet()
}

export function DesktopSettingsPage() {
  return (
    <SettingsPage title="Desktop" description="How OpenAgentd shows itself outside its window. Changes save at once.">
      {supportsIsland() && <NotchStatusSection />}
      {supportsPet() && <PetSettingsSection />}
    </SettingsPage>
  )
}
