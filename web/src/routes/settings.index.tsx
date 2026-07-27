/**
 * Settings "About" page — shown as the default section in the modal.
 * Contains app identity, backend connection, and the desktop updater card.
 * The mobile nav cards that used to live here are no longer needed since
 * the modal's own sidebar handles all section navigation.
 */
import { useState } from 'react'
import {
  Server,
  Download,
  Info,
  Shield,
  Image,
  AlignLeft,
  Type,
  Bell,
  TerminalSquare,
  ChevronRight,
  ExternalLink,
  MessageSquare,
  Users,
} from 'lucide-react'

import { AppBackendDialog } from '@/components/AppBackendDialog'
import { SettingsSection } from '@/components/settings/SettingsSection'
import { Button } from '@/components/ui/button'
import { checkForUpdates, downloadUpdate, fetchReleaseNotes, installUpdate, type ReleaseNotes, type UpdateStatus } from '@/lib/updater'
import { openExternalUrl } from '@/lib/open-external'
import { LazyMarkdownBlock } from '@/utils/LazyMarkdownBlock'
import { useHealthQuery } from '@/queries'
import { useSettingsStore } from '@/stores/useSettingsStore'

// ── Updates card ──────────────────────────────────────────────────────────

function UpdateSettingsCard() {
  const [status, setStatus] = useState<UpdateStatus | null>(null)
  const [pending, setPending] = useState(false)
  const [notesOpen, setNotesOpen] = useState(false)
  const [releaseNotes, setReleaseNotes] = useState<ReleaseNotes | null>(null)
  const [releaseNotesError, setReleaseNotesError] = useState<string | null>(null)

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

  async function openReleaseNotes() {
    if (!status?.version) return
    setNotesOpen(true)
    setReleaseNotesError(null)
    try {
      setReleaseNotes(await fetchReleaseNotes(status.version))
    } catch (error) {
      setReleaseNotesError(String(error))
    }
  }

  const title = statusTitle(status)
  const description = statusDescription(status)

  return (
    <SettingsSection title="Updates">
      <div className="flex items-start gap-3">
        <span className="flex h-8.5 w-8.5 shrink-0 items-center justify-center rounded bg-(--bg-key) text-(--color-text-muted) border border-(--color-border)" aria-hidden="true">
          <Download size={15} />
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-xs leading-relaxed text-(--color-text-muted)">{description}</p>
          {status?.version && (status.status === 'available' || status.status === 'downloaded') ? (
            <button className="mt-1.5 text-[11px] font-medium text-(--color-accent) underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-(--focus-ring)" onClick={() => void openReleaseNotes()}>
              See release notes
            </button>
          ) : null}
        </div>
        <span className="rounded bg-(--bg-key) px-1.5 py-0.5 text-[9px] font-semibold text-(--color-text-muted) border border-(--color-border) select-none">{title}</span>
      </div>

      <div className="mt-4 flex flex-wrap justify-end gap-2">
        <button className="rounded border border-(--color-border) bg-(--bg-card) px-2.5 py-1 text-xs font-medium text-(--color-text) hover:bg-(--bg-key)/40 disabled:cursor-not-allowed disabled:opacity-60 focus-visible:outline-none" disabled={pending} onClick={() => void onCheck()}>
          Check for updates
        </button>
        {status?.status === 'available' ? (
          <button className="rounded border border-(--color-border-strong) bg-(--bg-key) px-2.5 py-1 text-xs font-medium text-(--color-text) hover:bg-(--bg-key)/80 disabled:cursor-not-allowed disabled:opacity-60 focus-visible:outline-none" disabled={pending} onClick={() => void onDownload()}>
            Download
          </button>
        ) : null}
        {status?.status === 'downloaded' ? (
          <button className="rounded border border-(--color-border-strong) bg-(--bg-key) px-2.5 py-1 text-xs font-medium text-(--color-text) hover:bg-(--bg-key)/80 disabled:cursor-not-allowed disabled:opacity-60 focus-visible:outline-none" disabled={pending} onClick={() => void onInstall()}>
            Install and restart
          </button>
        ) : null}
      </div>

      {notesOpen && status?.notes ? (
        <div className="mobile-safe-overlay fixed inset-0 z-[60] flex items-center justify-center bg-black/40 p-4" role="dialog" aria-modal="true" aria-label="Release notes" onClick={() => setNotesOpen(false)}>
          <div className="max-h-[min(32rem,calc(100dvh-env(safe-area-inset-top,0px)-env(safe-area-inset-bottom,0px)-2rem))] w-full max-w-lg overflow-hidden rounded-md border border-(--color-border) bg-(--bg-card) text-(--color-text) shadow-2xl" onClick={(event) => event.stopPropagation()}>
            <div className="flex items-center justify-between gap-3 border-b border-(--color-border) px-4 py-3 select-none">
              <h3 className="text-sm font-semibold">Release notes</h3>
              <div className="flex items-center gap-2">
                {releaseNotes?.url ? <a className="rounded px-2 py-1 text-xs text-(--color-accent) hover:bg-(--bg-page)" href={releaseNotes.url} target="_blank" rel="noopener noreferrer" onClick={(event) => { event.preventDefault(); void openExternalUrl(releaseNotes.url!) }}>View in GitHub</a> : null}
                <button className="rounded px-2 py-1 text-xs text-(--color-text-muted) hover:bg-(--bg-page)" onClick={() => setNotesOpen(false)}>Close</button>
              </div>
            </div>
            <div className="max-h-[24rem] overflow-y-auto px-4 py-3 text-(--color-text)">
              <LazyMarkdownBlock content={`${releaseNotes?.body ?? status.notes ?? 'Loading release notes...'}${releaseNotesError ? `\n\nCould not load GitHub release notes: ${releaseNotesError}` : ''}`} />
            </div>
          </div>
        </div>
      ) : null}
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

  return (
    <div className="min-h-0 flex-1 overflow-y-auto bg-(--bg-page)">
      <div className="mx-auto max-w-3xl space-y-4 p-3 sm:p-5">
        <header className="flex items-center gap-3 select-none">
          <span
            className="flex h-9 w-9 items-center justify-center rounded bg-(--bg-key) text-(--color-text-muted) border border-(--color-border)"
            aria-hidden="true"
          >
            <Info size={15} />
          </span>
          <div>
            <h1 className="text-xs font-semibold text-(--color-text)">About openagentd</h1>
            <p className="text-[10px] font-mono text-(--color-text-subtle)">
              {version
                ? `On-machine AI assistant · v${version}`
                : 'On-machine AI assistant'}
            </p>
          </div>
        </header>

        {/* Preferences section for options missing in the bottom tab bar on mobile */}
        <div className="md:hidden">
          <SettingsSection title="Preferences">
            <div className="divide-y divide-(--color-border)">
              <button
                type="button"
                onClick={() => setSection('sandbox')}
                className="flex w-full items-center justify-between py-2.5 text-left text-xs text-(--color-text) hover:bg-(--bg-key)/20 focus:outline-none"
              >
                <div className="flex items-center gap-2.5">
                  <Shield size={14} className="text-(--color-text-muted)" />
                  <span>Sandbox Settings</span>
                </div>
                <ChevronRight size={14} className="text-(--color-text-subtle)" />
              </button>
              <button
                type="button"
                onClick={() => setSection('multimodal')}
                className="flex w-full items-center justify-between py-2.5 text-left text-xs text-(--color-text) hover:bg-(--bg-key)/20 focus:outline-none"
              >
                <div className="flex items-center gap-2.5">
                  <Image size={14} className="text-(--color-text-muted)" />
                  <span>Multimodal Settings</span>
                </div>
                <ChevronRight size={14} className="text-(--color-text-subtle)" />
              </button>
              <button
                type="button"
                onClick={() => setSection('summarization')}
                className="flex w-full items-center justify-between py-2.5 text-left text-xs text-(--color-text) hover:bg-(--bg-key)/20 focus:outline-none"
              >
                <div className="flex items-center gap-2.5">
                  <AlignLeft size={14} className="text-(--color-text-muted)" />
                  <span>Summarization Settings</span>
                </div>
                <ChevronRight size={14} className="text-(--color-text-subtle)" />
              </button>
              <button
                type="button"
                onClick={() => setSection('title-generation')}
                className="flex w-full items-center justify-between py-2.5 text-left text-xs text-(--color-text) hover:bg-(--bg-key)/20 focus:outline-none"
              >
                <div className="flex items-center gap-2.5">
                  <Type size={14} className="text-(--color-text-muted)" />
                  <span>Title Generation Settings</span>
                </div>
                <ChevronRight size={14} className="text-(--color-text-subtle)" />
              </button>
              <button
                type="button"
                onClick={() => setSection('notifications')}
                className="flex w-full items-center justify-between py-2.5 text-left text-xs text-(--color-text) hover:bg-(--bg-key)/20 focus:outline-none"
              >
                <div className="flex items-center gap-2.5">
                  <Bell size={14} className="text-(--color-text-muted)" />
                  <span>Notification Settings</span>
                </div>
                <ChevronRight size={14} className="text-(--color-text-subtle)" />
              </button>
              <button
                type="button"
                onClick={() => setSection('terminal')}
                className="flex w-full items-center justify-between py-2.5 text-left text-xs text-(--color-text) hover:bg-(--bg-key)/20 focus:outline-none"
              >
                <div className="flex items-center gap-2.5">
                  <TerminalSquare size={14} className="text-(--color-text-muted)" />
                  <span>Terminal Settings</span>
                </div>
                <ChevronRight size={14} className="text-(--color-text-subtle)" />
              </button>
            </div>
          </SettingsSection>
        </div>

        <SettingsSection title="Backend connection">
          <div className="flex flex-wrap items-start gap-3">
            <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-xs border border-(--color-border) bg-(--bg-key) text-(--color-text-muted)" aria-hidden="true">
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
              className="flex items-start gap-3 rounded-md border border-(--color-border) bg-(--bg-card) p-3 text-left transition-colors hover:bg-(--bg-key)/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-(--focus-ring)"
            >
              <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded bg-[#5865F2]/10 text-[#5865F2]" aria-hidden="true">
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
              className="flex items-start gap-3 rounded-md border border-(--color-border) bg-(--bg-card) p-3 text-left transition-colors hover:bg-(--bg-key)/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-(--focus-ring)"
            >
              <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded bg-[#1877F2]/10 text-[#1877F2]" aria-hidden="true">
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
