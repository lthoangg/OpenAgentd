/**
 * Settings → About OpenAgentd — app identity and version, desktop updates,
 * and community links. Appearance lives in General and the backend in
 * Connection.
 */
import { useState } from 'react'
import { ExternalLink, MessageSquare, Users, type LucideIcon } from 'lucide-react'

import { ReleaseNotesButton } from '@/components/ReleaseNotesDialog'
import { SettingsPage } from '@/components/settings/SettingsPage'
import { PanelRow } from '@/components/ui/panel-row'
import { PanelSection } from '@/components/ui/panel-section'
import { TEXT } from '@/components/settings/tokens'
import { Button } from '@/components/ui/button'
import { SectionCard } from '@/components/ui/section-card'
import { Seal, Wordmark } from '@/components/brand/Logo'
import { checkForUpdates, downloadUpdate, installUpdate, type UpdateStatus } from '@/lib/updater'
import { openExternalUrl } from '@/lib/open-external'
import { cn } from '@/lib/utils'
import { useHealthQuery } from '@/queries'

// ── Identity ──────────────────────────────────────────────────────────────

function IdentityCard({ version }: { version?: string }) {
  return (
    <SectionCard>
      <div className="flex items-center gap-4 px-4 py-5 sm:px-5">
        <Seal size={56} className="shrink-0 text-(--color-text)" />
        <div className="min-w-0 flex-1">
          <Wordmark height={20} title="OpenAgentd" className="block text-(--color-text)" />
          <p className={cn('mt-0.5 font-mono', TEXT.hint)}>
            {version ? `On-machine AI assistant · v${version}` : 'On-machine AI assistant'}
          </p>
          {version && <ReleaseNotesButton className="mt-2" version={version} />}
        </div>
      </div>
    </SectionCard>
  )
}

// ── Updates ───────────────────────────────────────────────────────────────

function UpdatesSection() {
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

  const showNotes = status?.version && (status.status === 'available' || status.status === 'downloaded')

  return (
    <PanelSection title="Updates" flush>
      <PanelRow
        label={
          <span className="flex items-center gap-2">
            Desktop app
            <span className="rounded-xs border border-(--color-border) bg-(--bg-key) px-1.5 py-0.5 text-[11px] font-semibold text-(--color-text-muted) select-none">
              {statusTitle(status)}
            </span>
          </span>
        }
        description={
          <>
            <span role="status">{statusDescription(status)}</span>
            {showNotes ? (
              <ReleaseNotesButton className="mt-1.5 block" version={status.version!} fallbackNotes={status.notes} />
            ) : null}
          </>
        }
      >
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
      </PanelRow>
    </PanelSection>
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

// ── Community ─────────────────────────────────────────────────────────────

function CommunityLink({ href, icon: Icon, tint, title, body }: {
  href: string
  icon: LucideIcon
  /** Brand tint for the icon chip. */
  tint: string
  title: string
  body: string
}) {
  return (
    <button
      type="button"
      onClick={() => void openExternalUrl(href)}
      className={cn(
        'flex items-start gap-3 rounded-sm border border-(--color-border) bg-(--bg-card) p-4 text-left',
        'transition-colors duration-(--motion-instant) hover:bg-(--bg-key)/40',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-(--focus-ring)/40',
      )}
    >
      <span className={cn('flex size-9 shrink-0 items-center justify-center rounded-sm', tint)} aria-hidden="true">
        <Icon size={16} />
      </span>
      <span className="min-w-0 flex-1">
        <span className={cn('flex items-center gap-1.5', TEXT.title)}>
          <span>{title}</span>
          <ExternalLink size={12} className="text-(--color-text-subtle)" aria-hidden="true" />
        </span>
        <span className={cn('mt-1 block', TEXT.hint)}>{body}</span>
      </span>
    </button>
  )
}

// ── Page ──────────────────────────────────────────────────────────────────

export function AboutSettingsPage() {
  const version = useHealthQuery().data?.version

  return (
    <SettingsPage title="About OpenAgentd">
      <IdentityCard version={version} />

      <UpdatesSection />

      <section aria-labelledby="settings-community-heading" className="space-y-3">
        <div className="select-none">
          <h2 id="settings-community-heading" className={TEXT.title}>Community &amp; Support</h2>
          <p className={cn('mt-1', TEXT.hint)}>Ask questions, share what you built, and follow along.</p>
        </div>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <CommunityLink
            href="https://discord.gg/cz6GQHQUMg"
            icon={MessageSquare}
            tint="bg-[#5865F2]/10 text-[#5865F2]"
            title="Discord Server"
            body="Join the chat, ask questions, and get help from the community."
          />
          <CommunityLink
            href="https://www.facebook.com/groups/1256361676707935"
            icon={Users}
            tint="bg-[#1877F2]/10 text-[#1877F2]"
            title="Facebook Group"
            body="Connect with other OpenAgentd users and maintainers on Facebook."
          />
        </div>
      </section>
    </SettingsPage>
  )
}
