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
} from 'lucide-react'

import { AppBackendDialog } from '@/components/AppBackendDialog'
import { checkForUpdates, downloadUpdate, fetchReleaseNotes, installUpdate, type ReleaseNotes, type UpdateStatus } from '@/lib/updater'
import { openExternalUrl } from '@/lib/open-external'
import { LazyMarkdownBlock } from '@/utils/LazyMarkdownBlock'
import { useHealthQuery } from '@/queries'

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
    <section className="rounded-md border border-(--color-border) bg-(--bg-card) p-4 shadow-sm">
      <div className="flex items-start gap-3">
        <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-(--bg-key) text-(--color-text-muted) ring-1 ring-(--color-border)" aria-hidden="true">
          <Download size={18} />
        </span>
        <div className="min-w-0 flex-1">
          <h2 className="text-sm font-semibold text-(--color-text)">Updates</h2>
          <p className="mt-1 text-xs leading-5 text-(--color-text-muted)">{description}</p>
          {status?.version && (status.status === 'available' || status.status === 'downloaded') ? (
            <button className="mt-2 text-xs font-medium text-(--color-accent) underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-(--focus-ring)" onClick={() => void openReleaseNotes()}>
              See release notes
            </button>
          ) : null}
        </div>
        <span className="rounded-md bg-(--bg-key) px-2 py-0.5 text-[10px] font-medium text-(--color-text-muted)">{title}</span>
      </div>

      <div className="mt-4 flex flex-wrap justify-end gap-2">
        <button className="rounded-md border border-(--color-border) px-3 py-1.5 text-xs font-medium text-(--color-text) hover:bg-(--bg-page) disabled:cursor-not-allowed disabled:opacity-60" disabled={pending} onClick={() => void onCheck()}>
          Check for updates
        </button>
        {status?.status === 'available' ? (
          <button className="rounded-md border border-(--color-border-strong) bg-(--bg-key) px-3 py-1.5 text-xs font-medium text-(--color-text) hover:bg-(--bg-page) disabled:cursor-not-allowed disabled:opacity-60" disabled={pending} onClick={() => void onDownload()}>
            Download
          </button>
        ) : null}
        {status?.status === 'downloaded' ? (
          <button className="rounded-md border border-(--color-border-strong) bg-(--bg-key) px-3 py-1.5 text-xs font-medium text-(--color-text) hover:bg-(--bg-page) disabled:cursor-not-allowed disabled:opacity-60" disabled={pending} onClick={() => void onInstall()}>
            Install and restart
          </button>
        ) : null}
      </div>

      {notesOpen && status?.notes ? (
        <div className="mobile-safe-overlay fixed inset-0 z-[60] flex items-center justify-center bg-black/40 p-4" role="dialog" aria-modal="true" aria-label="Release notes" onClick={() => setNotesOpen(false)}>
          <div className="max-h-[min(32rem,calc(100dvh-env(safe-area-inset-top,0px)-env(safe-area-inset-bottom,0px)-2rem))] w-full max-w-lg overflow-hidden rounded-md border border-(--color-border) bg-(--bg-card) text-(--color-text) shadow-2xl" onClick={(event) => event.stopPropagation()}>
            <div className="flex items-center justify-between gap-3 border-b border-(--color-border) px-4 py-3">
              <h3 className="text-sm font-semibold">Release notes</h3>
              <div className="flex items-center gap-2">
                {releaseNotes?.url ? <a className="rounded-md px-2 py-1 text-xs text-(--color-accent) hover:bg-(--bg-page)" href={releaseNotes.url} target="_blank" rel="noopener noreferrer" onClick={(event) => { event.preventDefault(); void openExternalUrl(releaseNotes.url!) }}>View in GitHub</a> : null}
                <button className="rounded-md px-2 py-1 text-xs text-(--color-text-muted) hover:bg-(--bg-page)" onClick={() => setNotesOpen(false)}>Close</button>
              </div>
            </div>
            <div className="max-h-[24rem] overflow-y-auto px-4 py-3 text-(--color-text)">
              <LazyMarkdownBlock content={`${releaseNotes?.body ?? status.notes ?? 'Loading release notes...'}${releaseNotesError ? `\n\nCould not load GitHub release notes: ${releaseNotesError}` : ''}`} />
            </div>
          </div>
        </div>
      ) : null}
    </section>
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

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto max-w-3xl space-y-6 px-3 pt-4 pb-8 sm:space-y-8 sm:px-8 sm:pt-8 sm:pb-12">
        <header className="flex items-center gap-3">
          <span
            className="flex h-10 w-10 items-center justify-center rounded-xl bg-(--bg-key) text-(--color-text-muted) ring-1 ring-(--color-border)"
            aria-hidden="true"
          >
            <Info size={18} />
          </span>
          <div>
            <h1 className="text-lg font-semibold text-(--color-text)">About openagentd</h1>
            <p className="text-xs text-(--color-text-muted)">
              {version
                ? `On-machine AI assistant · v${version}`
                : 'On-machine AI assistant'}
            </p>
          </div>
        </header>

        <section className="rounded-md border border-(--color-border) bg-(--bg-card) p-4 shadow-sm">
          <div className="flex items-start gap-3">
            <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-(--bg-key) text-(--color-text-muted) ring-1 ring-(--color-border)" aria-hidden="true">
              <Server size={18} />
            </span>
            <div className="min-w-0 flex-1">
              <h2 className="text-sm font-semibold text-(--color-text)">Backend connection</h2>
              <p className="mt-1 text-xs leading-5 text-(--color-text-muted)">
                Connect this app to an existing OpenAgentd server, or switch back to the bundled local sidecar when available.
              </p>
            </div>
            <button
              type="button"
              onClick={() => setBackendDialogOpen(true)}
              className="rounded-md border border-(--color-border) px-3 py-1.5 text-xs font-medium text-(--color-text) hover:bg-(--bg-page)"
            >
              Configure
            </button>
          </div>
        </section>

        <UpdateSettingsCard />

        <AppBackendDialog open={backendDialogOpen} onOpenChange={setBackendDialogOpen} />
      </div>
    </div>
  )
}
