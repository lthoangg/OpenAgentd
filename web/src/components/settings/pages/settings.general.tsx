/**
 * Settings → General — app-wide preferences that live on this device:
 * colour theme, transcript style and, in the desktop app, the notch status
 * (macOS) and the desktop pet (macOS and Windows).
 */
import { type ComponentType, useEffect, useState } from 'react'

import { THEME_OPTIONS } from '@/components/ThemeToggle'
import { SettingsPage } from '@/components/settings/SettingsPage'
import { PetSettingsSection } from '@/components/settings/PetSettingsSection'
import { PanelRow } from '@/components/ui/panel-row'
import { PanelSection } from '@/components/ui/panel-section'
import { SegmentedControl } from '@/components/ui/segmented-control'
import { Switch } from '@/components/ui/switch'
import { useThemePreference } from '@/hooks/useThemePreference'
import { type IslandSettings, readIslandSettings, supportsIsland, updateIslandSettings } from '@/lib/island-setting'
import { supportsPet } from '@/lib/pet-setting'
import { TRANSCRIPT_STYLES, useDisplayPrefsStore } from '@/stores/useDisplayPrefsStore'

function SegmentedChoice<T extends string>({ label, options, value, onChange }: {
  label: string
  options: readonly { value: T; label: string; Icon?: ComponentType<{ size?: number; 'aria-hidden'?: boolean | 'true' }> }[]
  value: T
  onChange: (next: T) => void
}) {
  return (
    <SegmentedControl
      label={label}
      value={value}
      onChange={onChange}
      options={options.map(({ value: option, label: optionLabel, Icon }) => ({
        value: option,
        label: optionLabel,
        icon: Icon ? <Icon size={13} aria-hidden="true" /> : undefined,
      }))}
    />
  )
}

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

  if (settings === null) return null

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
    <PanelSection title="Desktop" flush>
      <PanelRow
        label="Agent status in the notch"
        htmlFor="island-enabled"
        description={error ?? 'While you work in another app, the notch shows running agents, questions waiting on you, and finished turns.'}
      >
        <Switch id="island-enabled" checked={settings.enabled} onCheckedChange={(enabled) => change({ enabled })} />
      </PanelRow>
      {NOTCH_OPTIONS.map((option) => (
        <PanelRow key={option.key} label={option.label} htmlFor={`island-${option.key}`} description={option.description}>
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

export function GeneralSettingsPage() {
  const { preference, setPreference } = useThemePreference()
  const transcriptStyle = useDisplayPrefsStore((s) => s.transcriptStyle)
  const setTranscriptStyle = useDisplayPrefsStore((s) => s.setTranscriptStyle)

  return (
    <SettingsPage
      title="General"
      description="How OpenAgentd looks on this device."
    >
      <PanelSection title="Appearance" flush>
        <PanelRow label="Theme" description="Follow the system, or always use light or dark.">
          <SegmentedChoice label="Theme" options={THEME_OPTIONS} value={preference} onChange={setPreference} />
        </PanelRow>
        <PanelRow
          label="Transcript"
          description="Reader folds each turn's thinking and tool calls into one row."
        >
          <SegmentedChoice label="Transcript" options={TRANSCRIPT_STYLES} value={transcriptStyle} onChange={setTranscriptStyle} />
        </PanelRow>
      </PanelSection>
      {supportsIsland() && <NotchStatusSection />}
      {supportsPet() && <PetSettingsSection />}
    </SettingsPage>
  )
}
