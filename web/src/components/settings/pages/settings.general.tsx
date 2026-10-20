/**
 * Settings → General — app-wide preferences that live on this device:
 * colour theme and transcript style.
 */
import { type ComponentType } from 'react'

import { THEME_OPTIONS } from '@/components/ThemeToggle'
import { SettingsPage } from '@/components/settings/SettingsPage'
import { PanelRow } from '@/components/ui/panel-row'
import { PanelSection } from '@/components/ui/panel-section'
import { SegmentedControl } from '@/components/ui/segmented-control'
import { useThemePreference } from '@/hooks/useThemePreference'
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
    </SettingsPage>
  )
}
