/**
 * Settings → General — how OpenAgentd looks on this device (Appearance:
 * color theme and text size) and how chats show (Chat: how much detail,
 * Simple or Full, and whether the agent's previews open on their own). Each
 * pick applies at once. The desktop
 * app's notch status and pet live on Settings → Desktop.
 *
 * Each choice is the app's own segmented control on every platform, the
 * phone apps included.
 */
import { type ComponentType } from 'react'

import { THEME_OPTIONS } from '@/components/ThemeToggle'
import { SettingsPage } from '@/components/settings/SettingsPage'
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
  const textSize = useDisplayPrefsStore((s) => s.textSize)
  const setTextSize = useDisplayPrefsStore((s) => s.setTextSize)
  const previewOpen = useDisplayPrefsStore((s) => s.previewOpen)
  const setPreviewOpen = useDisplayPrefsStore((s) => s.setPreviewOpen)

  return (
    <SettingsPage
      title="General"
      description="How OpenAgentd looks and how chats show on this device."
    >
      <PanelSection title="Appearance" flush>
        <PanelRow label="Theme" description="Follow the system, or always use light or dark.">
          <SegmentedChoice label="Theme" options={THEME_OPTIONS} value={preference} onChange={setPreference} />
        </PanelRow>
        <PanelRow
          label="Text size"
          description="On phones and tablets, the system text size adds to it."
        >
          <SegmentedChoice label="Text size" options={TEXT_SIZES} value={textSize} onChange={setTextSize} />
        </PanelRow>
      </PanelSection>
      <PanelSection title="Chat" flush>
        <PanelRow
          label="Detail"
          description="Simple shows answers and folds the work. Full shows every step and number."
        >
          <SegmentedChoice label="Detail" options={TRANSCRIPT_STYLES} value={transcriptStyle} onChange={setTranscriptStyle} />
        </PanelRow>
        <PanelRow
          label="Open previews"
          description="When the agent shows a page."
        >
          <SegmentedChoice label="Open previews" options={PREVIEW_OPENS} value={previewOpen} onChange={setPreviewOpen} />
        </PanelRow>
      </PanelSection>
    </SettingsPage>
  )
}
