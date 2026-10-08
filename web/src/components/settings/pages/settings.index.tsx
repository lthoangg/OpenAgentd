/**
 * Settings "About" page — shown as the default section in the modal.
 * Contains app identity, backend connection, and the desktop updater card.
 * The mobile nav cards that used to live here are no longer needed since
 * the modal's own sidebar handles all section navigation.
 */
import { useState, type ComponentType } from 'react'
import {
  Server,
  Download,
  Info,
  ChevronRight,
  ExternalLink,
  MessageSquare,
  Users,
} from 'lucide-react'

import { AppBackendDialog } from '@/components/AppBackendDialog'
import { ReleaseNotesButton } from '@/components/ReleaseNotesDialog'
import { THEME_OPTIONS } from '@/components/ThemeToggle'
import { SettingsSection } from '@/components/settings/SettingsSection'
import { useVisibleSettingsSections } from '@/components/settings/useVisibleSections'
import { ICON_SIZE } from '@/components/settings/tokens'
import { Button } from '@/components/ui/button'
import { SegmentedControl } from '@/components/ui/segmented-control'
import { checkForUpdates, downloadUpdate, installUpdate, type UpdateStatus } from '@/lib/updater'
import { openExternalUrl } from '@/lib/open-external'
import { useHealthQuery } from '@/queries'
import { useThemePreference } from '@/hooks/useThemePreference'
import { TRANSCRIPT_STYLES, useDisplayPrefsStore } from '@/stores/useDisplayPrefsStore'
import { useSettingsStore } from '@/stores/useSettingsStore'

// ── Appearance ────────────────────────────────────────────────────────────

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

function AppearanceSection() {
  const { preference, setPreference } = useThemePreference()
  const transcriptStyle = useDisplayPrefsStore((s) => s.transcriptStyle)
  const setTranscriptStyle = useDisplayPrefsStore((s) => s.setTranscriptStyle)
  return (
    <SettingsSection title="Appearance">
      <div className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="text-xs text-(--color-text-muted)">Theme</p>
          <SegmentedChoice label="Theme" options={THEME_OPTIONS} value={preference} onChange={setPreference} />
        </div>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="min-w-0 flex-1">
            <p className="text-xs text-(--color-text-muted)">Transcript</p>
            <p className="mt-0.5 text-[11px] text-(--color-text-subtle)">
              Reader folds each turn&apos;s thinking and tool calls into one row, and lists the files it changed.
            </p>
          </div>
          <SegmentedChoice label="Transcript" options={TRANSCRIPT_STYLES} value={transcriptStyle} onChange={setTranscriptStyle} />
        </div>
      </div>
    </SettingsSection>
  )
}

// ── Updates card ──────────────────────────────────────────────────────────

function UpdateSettingsCard() {
  const [status, setStatus] = useState<UpdateStatus | null>(null)
  const [pending, setPending] = useState(false)

  async function onCheck() {
    setPending(true)
    setStatus({ status: 'checking' })
    try {
      setStatus(await checkForUpdates(false))
    } catch (error) {
      setStatus({ status: 'error', message: String(error) })
    } finally {
      setPending(false)
    }
  }

  async function onDownload() {
    setPending(true)
    try {
      setStatus(await downloadUpdate())
    } catch (error) {
      setStatus({ status: 'error', message: String(error) })
    } finally {
      setPending(false)
    }
  }

  async function onInstall() {
    setPending(true)
    setStatus((current) => current ? { ...current, status: 'installing' } : { status: 'installing' })
    try {
      const RESTART_TIMEOUT_MS = 60_000
      await Promise.race([
        installUpdate(),
        new Promise<never>((_, reject) =>
          setTimeout(
            () => reject(new Error('Restart timed out — please quit and reopen OpenAgentd.')),
            RESTART_TIMEOUT_MS,
          ),
        ),
      ])
    } catch (error) {
      setStatus({ status: 'error', message: String(error) })
      setPending(false)
    }
  }

  const title = statusTitle(status)
  const description = statusDescription(status)

  return (
    <SettingsSection title="Updates">
      <div className="flex items-start gap-3">
        <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-sm border border-(--color-border) bg-(--bg-key) text-(--color-text-muted)" aria-hidden="true">
          <Download size={14} />
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-xs leading-relaxed text-(--color-text-muted)">{description}</p>
          {status?.version && (status.status === 'available' || status.status === 'downloaded') ? (
            <ReleaseNotesButton className="mt-1.5" version={status.version} fallbackNotes={status.notes} />
          ) : null}
        </div>
        <span className="rounded-xs bg-(--bg-key) px-1.5 py-0.5 text-xs md:text-[11px] font-semibold text-(--color-text-muted) border border-(--color-border) select-none">{title}</span>
      </div>

      <div className="mt-4 flex flex-wrap justify-end gap-2">
        <Button size="sm" variant="default" disabled={pending} onClick={() => void onCheck()}>
          Check for updates
        </Button>
        {status?.status === 'available' ? (
          <Button size="sm" variant="primary" disabled={pending} onClick={() => void onDownload()}>
            Download
          </Button>
        ) : null}
        {status?.status === 'downloaded' ? (
          <Button size="sm" variant="primary" disabled={pending} onClick={() => void onInstall()}>
            Install and restart
          </Button>
        ) : null}
      </div>

    </SettingsSection>
  )
}

function statusTitle(status: UpdateStatus | null): string {
  if (!status) return 'Manual'
  if (status.status === 'checking') return 'Checking'
  if (status.status === 'available') return 'Available'
  if (status.status === 'downloaded') return 'Ready'
  if (status.status === 'installing') return 'Installing'
  if (status.status === 'up_to_date') return 'Current'
  if (status.status === 'error') return 'Error'
  return 'Manual'
}

function statusDescription(status: UpdateStatus | null): string {
  if (!status) return 'Check for desktop app updates from here. Automatic checks also run in the background.'
  if (status.message) return status.message
  if (status.status === 'checking') return 'Checking the desktop update feed...'
  if (status.status === 'available') return `OpenAgentd ${status.version} is available. Current version: ${status.current_version}.`
  if (status.status === 'downloaded') return `OpenAgentd ${status.version} has been downloaded and is ready to install.`
  if (status.status === 'installing') return 'Installing the update. OpenAgentd will restart when installation completes.'
  if (status.status === 'up_to_date') return `OpenAgentd ${status.current_version} is the latest version.`
  if (status.status === 'error') return 'Could not check for updates.'
  return 'Check for desktop app updates from here.'
}

// ── Hub page ──────────────────────────────────────────────────────────────

export function SettingsHubPage() {
  const healthQ = useHealthQuery()
  const [backendDialogOpen, setBackendDialogOpen] = useState(false)
  const version = healthQ.data?.version
  const setSection = useSettingsStore((s) => s.setSection)
  const sections = useVisibleSettingsSections()

  return (
    <div className="min-h-0 flex-1 overflow-y-auto bg-(--bg-page)">
      <div className="mx-auto max-w-3xl space-y-4 p-3 sm:p-5">
        <header className="flex items-center gap-3 select-none">
          <span
            className="flex h-9 w-9 items-center justify-center rounded-md bg-(--bg-key) text-(--color-text-muted) border border-(--color-border)"
            aria-hidden="true"
          >
            <Info size={14} />
          </span>
          <div>
            <h1 className="text-xs font-semibold text-(--color-text)">About OpenAgentd</h1>
            <p className="text-xs md:text-[11px] font-mono text-(--color-text-subtle)">
              {version
                ? `On-machine AI assistant · v${version}`
                : 'On-machine AI assistant'}
            </p>
          </div>
        </header>

        {/*
          Sections that have no slot in the five-item mobile tab bar are
          reached from here. Derived from the registry, so a new section shows
          up automatically instead of needing another hand-written button.
        */}
        <div className="md:hidden">
          <SettingsSection title="Preferences">
            <div className="divide-y divide-(--color-border)">
              {sections.filter((s) => !s.mobileTab).map((item) => {
                const Icon = item.icon
                return (
                  <button
                    key={item.id}
                    type="button"
                    onClick={() => setSection(item.id)}
                    className="flex min-h-9 w-full items-center justify-between py-2.5 text-left text-xs text-(--color-text) hover:bg-(--bg-key)/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-(--focus-ring)/40"
                  >
                    <span className="flex items-center gap-2.5">
                      <Icon size={ICON_SIZE} className="text-(--color-text-muted)" aria-hidden="true" />
                      <span>{item.label}</span>
                    </span>
                    <ChevronRight size={ICON_SIZE} className="text-(--color-text-subtle)" aria-hidden="true" />
                  </button>
                )
              })}
            </div>
          </SettingsSection>
        </div>

        <AppearanceSection />

        <SettingsSection title="Backend connection">
          <div className="flex flex-wrap items-start gap-3">
            <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-sm border border-(--color-border) bg-(--bg-key) text-(--color-text-muted)" aria-hidden="true">
              <Server size={14} />
            </span>
            <div className="min-w-0 flex-1">
              <p className="text-xs leading-relaxed text-(--color-text-muted)">
                Connect this app to an existing OpenAgentd server, or switch back to the bundled local sidecar when available.
              </p>
            </div>
            <Button type="button" size="sm" variant="default" onClick={() => setBackendDialogOpen(true)}>
              Configure
            </Button>
          </div>
        </SettingsSection>

        <SettingsSection title="Community & Support">
          <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2">
            <button
              type="button"
              onClick={() => void openExternalUrl('https://discord.gg/cz6GQHQUMg')}
              className="flex items-start gap-3 rounded-md border border-(--color-border) bg-(--bg-card) p-3 text-left transition-colors hover:bg-(--bg-key)/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-(--focus-ring)/40"
            >
              <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-sm bg-[#5865F2]/10 text-[#5865F2]" aria-hidden="true">
                <MessageSquare size={16} />
              </span>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-1 text-xs font-semibold text-(--color-text)">
                  <span>Discord Server</span>
                  <ExternalLink size={11} className="text-(--color-text-subtle)" />
                </div>
                <p className="mt-0.5 text-[11px] text-(--color-text-muted)">
                  Join the chat, ask questions, and get help from the community.
                </p>
              </div>
            </button>

            <button
              type="button"
              onClick={() => void openExternalUrl('https://www.facebook.com/groups/1256361676707935')}
              className="flex items-start gap-3 rounded-md border border-(--color-border) bg-(--bg-card) p-3 text-left transition-colors hover:bg-(--bg-key)/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-(--focus-ring)/40"
            >
              <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-sm bg-[#1877F2]/10 text-[#1877F2]" aria-hidden="true">
                <Users size={16} />
              </span>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-1 text-xs font-semibold text-(--color-text)">
                  <span>Facebook Group</span>
                  <ExternalLink size={11} className="text-(--color-text-subtle)" />
                </div>
                <p className="mt-0.5 text-[11px] text-(--color-text-muted)">
                  Connect with other OpenAgentd users and maintainers on Facebook.
                </p>
              </div>
            </button>
          </div>
        </SettingsSection>

        <UpdateSettingsCard />

        <AppBackendDialog open={backendDialogOpen} onOpenChange={setBackendDialogOpen} />
      </div>
    </div>
  )
}
