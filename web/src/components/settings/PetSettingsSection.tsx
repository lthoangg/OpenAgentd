/**
 * Settings → General → Desktop pet (macOS and Windows app): a pixel cat
 * that walks along the bottom of the screen and shows agent notifications
 * in its bubble. Off by default; the shell stores the settings.
 */
import { useEffect, useState } from 'react'

import { PanelRow } from '@/components/ui/panel-row'
import { PanelSection } from '@/components/ui/panel-section'
import { SegmentedControl } from '@/components/ui/segmented-control'
import { Switch } from '@/components/ui/switch'
import { listenPetSettings, readPetSettings, updatePetSettings, type PetSettings } from '@/lib/pet-setting'
import { BODY_COLOURS } from '@/pet/sprites'
import type { BubbleKinds, PetColour, PetMovement, PetSize } from '@/pet/state'

type Patch = Partial<Omit<PetSettings, 'position'>>

const COLOURS: ReadonlyArray<{ value: PetColour; label: string }> = [
  { value: 'orange', label: 'Orange' },
  { value: 'paper', label: 'Paper' },
  { value: 'bark', label: 'Bark' },
  { value: 'blue', label: 'Blue' },
]

const SIZES: ReadonlyArray<{ value: PetSize; label: string }> = [
  { value: 'small', label: 'Small' },
  { value: 'medium', label: 'Medium' },
  { value: 'large', label: 'Large' },
]

const MOVEMENTS: ReadonlyArray<{ value: PetMovement; label: string }> = [
  { value: 'still', label: 'Stay put' },
  { value: 'calm', label: 'Calm' },
  { value: 'playful', label: 'Playful' },
]

const KINDS: ReadonlyArray<{ key: keyof BubbleKinds; label: string; description: string }> = [
  { key: 'inputNeeded', label: 'Questions', description: 'An agent stopped to ask you something. Stays until answered.' },
  { key: 'assistantDone', label: 'Finished turns', description: 'A turn finished or failed. Fades after a few seconds.' },
  { key: 'reminderFired', label: 'Reminders', description: 'A reminder went off. Fades after a few seconds.' },
]

export function PetSettingsSection() {
  const [settings, setSettings] = useState<PetSettings | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    let unlisten: (() => void) | undefined
    void readPetSettings().then((value) => {
      if (!cancelled) setSettings(value)
    })
    // The tray turns it on and off too.
    void listenPetSettings((value) => {
      if (!cancelled) setSettings(value)
    }).then((stop) => {
      if (cancelled) stop()
      else unlisten = stop
    })
    return () => {
      cancelled = true
      unlisten?.()
    }
  }, [])

  if (settings === null) return null

  const change = (patch: Patch) => {
    const previous = settings
    setSettings({ ...settings, ...patch })
    setError(null)
    updatePetSettings(patch).then(setSettings, (err: unknown) => {
      setSettings(previous)
      setError(err instanceof Error ? err.message : String(err))
    })
  }
  const off = !settings.enabled

  return (
    <PanelSection title="Desktop pet" flush>
      <PanelRow
        label="Show a desktop pet"
        htmlFor="pet-enabled"
        description={error ?? 'A small cat walks along the bottom of your screen and reacts to your agents. It never takes focus, and clicks beside it reach the app behind.'}
      >
        <Switch id="pet-enabled" checked={settings.enabled} onCheckedChange={(enabled) => change({ enabled })} />
      </PanelRow>
      <PanelRow label="Character" description="More characters may come later.">
        <SegmentedControl label="Character" value={settings.character} disabled={off} onChange={(character) => change({ character })} options={[{ value: 'cat', label: 'Cat' }]} />
      </PanelRow>
      <PanelRow label="Colour">
        <SegmentedControl
          label="Colour"
          value={settings.colour}
          disabled={off}
          onChange={(colour) => change({ colour })}
          options={COLOURS.map((c) => ({
            ...c,
            icon: <span aria-hidden="true" className="inline-block size-2.5 rounded-full border border-(--color-border-strong)" style={{ background: BODY_COLOURS[c.value] }} />,
          }))}
        />
      </PanelRow>
      <PanelRow label="Size">
        <SegmentedControl label="Size" value={settings.size} disabled={off} onChange={(size) => change({ size })} options={SIZES} />
      </PanelRow>
      <PanelRow label="Movement" description="Stay put keeps it where you drop it. Drag it along the edge, or onto another display.">
        <SegmentedControl label="Movement" value={settings.movement} disabled={off} onChange={(movement) => change({ movement })} options={MOVEMENTS} />
      </PanelRow>
      <PanelRow
        label="Show notifications in its bubble"
        htmlFor="pet-bubbles"
        description="Instead of the system banner. Whenever the pet is hidden, the system banner is used."
      >
        <Switch id="pet-bubbles" checked={settings.bubbles} disabled={off} onCheckedChange={(bubbles) => change({ bubbles })} />
      </PanelRow>
      {KINDS.map((kind) => (
        <PanelRow key={kind.key} label={kind.label} htmlFor={`pet-kind-${kind.key}`} description={kind.description} className="pl-8">
          <Switch
            id={`pet-kind-${kind.key}`}
            checked={settings.bubbleKinds[kind.key]}
            disabled={off || !settings.bubbles}
            onCheckedChange={(checked) => change({ bubbleKinds: { ...settings.bubbleKinds, [kind.key]: checked } })}
          />
        </PanelRow>
      ))}
      <PanelRow
        label="Show while OpenAgentd is in front"
        htmlFor="pet-front"
        description="By default it steps aside while you use the app."
      >
        <Switch id="pet-front" checked={settings.showWhenFrontmost} disabled={off} onCheckedChange={(showWhenFrontmost) => change({ showWhenFrontmost })} />
      </PanelRow>
    </PanelSection>
  )
}
