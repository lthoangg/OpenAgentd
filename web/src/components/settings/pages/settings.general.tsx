/**
 * Settings → Appearance — how OpenAgentd looks on this device: color theme,
 * text size, transcript style and where the agent's previews open. Each
 * pick applies at once. The desktop
 * app's notch status and pet live on Settings → Desktop.
 *
 * In the phone apps each choice opens the system's own picker (an iOS action
 * sheet, an Android single-choice dialog); elsewhere it is a segmented
 * control.
 */
import { type ComponentType } from 'react'

import { THEME_OPTIONS } from '@/components/ThemeToggle'
import { SettingsPage } from '@/components/settings/SettingsPage'
import { NativeSelect } from '@/components/ui/native-select'
import { PanelRow } from '@/components/ui/panel-row'
import { PanelSection } from '@/components/ui/panel-section'
import { SegmentedControl } from '@/components/ui/segmented-control'
import { useThemePreference } from '@/hooks/useThemePreference'
import { PREVIEW_OPENS, TEXT_SIZES, TRANSCRIPT_STYLES, useDisplayPrefsStore } from '@/stores/useDisplayPrefsStore'

function SegmentedChoice<T extends string>({ label, options, value, onChange }: {
  label: string
  options: readonly { value: T; label: string; Icon?: ComponentType<{ size?: number; 'aria-hidden'?: boolean | 'true' }> }[]
  value: T
  onChange: (next: T) => void
}) {
  const segmented = (
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
  return (
    <NativeSelect
      title={label}
      value={value}
      onValueChange={(next) => onChange(next as T)}
      options={options.map(({ value: option, label: optionLabel }) => ({ value: option, label: optionLabel }))}
      fallback={segmented}
    />
  )
}

export function GeneralSettingsPage() {
  const { preference, setPreference } = useThemePreference()
  const transcriptStyle = useDisplayPrefsStore((s) => s.transcriptStyle)
  const setTranscriptStyle = useDisplayPrefsStore((s) => s.setTranscriptStyle)
  const textSize = useDisplayPrefsStore((s) => s.textSize)
  const setTextSize = useDisplayPrefsStore((s) => s.setTextSize)
  const previewOpen = useDisplayPrefsStore((s) => s.previewOpen)
  const setPreviewOpen = useDisplayPrefsStore((s) => s.setPreviewOpen)

  return (
    <SettingsPage
      title="Appearance"
      description="How OpenAgentd looks on this device."
    >
      <PanelSection title="Look" flush>
        <PanelRow label="Theme" description="Follow the system, or always use light or dark.">
          <SegmentedChoice label="Theme" options={THEME_OPTIONS} value={preference} onChange={setPreference} />
        </PanelRow>
        <PanelRow
          label="Text size"
          description="Compact is the densest. On iPhone, iPad and Android, the system text size adds to it."
        >
          <SegmentedChoice label="Text size" options={TEXT_SIZES} value={textSize} onChange={setTextSize} />
        </PanelRow>
        <PanelRow
          label="Transcript"
          description="Reader groups each reply's thinking and tool calls into one summary row."
        >
          <SegmentedChoice label="Transcript" options={TRANSCRIPT_STYLES} value={transcriptStyle} onChange={setTranscriptStyle} />
        </PanelRow>
        <PanelRow
          label="Previews"
          description="Where a page the agent opens with its preview tool goes: straight into the Review panel, or only when you click Open on its row."
        >
          <SegmentedChoice label="Previews" options={PREVIEW_OPENS} value={previewOpen} onChange={setPreviewOpen} />
        </PanelRow>
      </PanelSection>
    </SettingsPage>
  )
}
