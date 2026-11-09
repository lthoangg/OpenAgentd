/**
 * Settings → About OpenAgentd — app identity, client and server versions,
 * app updates (desktop and mobile shells), and community links. Appearance
 * lives in General and the backend in Connection.
 */
import { useEffect, useState } from 'react'
import { AlertTriangle, ExternalLink, Globe, MessageSquare, Shield, Users, type LucideIcon } from 'lucide-react'

import { PRIVACY_URL } from '@/components/AiDataConsent'

import { ReleaseNotesButton } from '@/components/ReleaseNotesDialog'
import { SettingsPage } from '@/components/settings/SettingsPage'
import { ServerUpdateButton, ServerUpdateConfirm, ServerUpdateNote, useServerUpdateFlow } from '@/components/settings/ServerUpdate'
import { PanelRow } from '@/components/ui/panel-row'
import { PanelSection } from '@/components/ui/panel-section'
import { TEXT } from '@/components/settings/tokens'
import { Button } from '@/components/ui/button'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'
import { SectionCard } from '@/components/ui/section-card'
import { Seal, Wordmark } from '@/components/brand/Logo'
import { getPlatform } from '@/hooks/use-platform'
import { clientLabel, clientVersion, versionSkew, WEB_BUILD_VERSION } from '@/lib/app-version'
import { checkForUpdates, downloadUpdate, hasInAppUpdates, installUpdate, type UpdateStatus } from '@/lib/updater'
import { apiBaseUrl } from '@/api/base-url'
import { openExternalUrl } from '@/lib/open-external'
import { cn } from '@/lib/utils'
import { useBackendStatusQuery, useHealthQuery } from '@/queries/useHealthQuery'
import { errorMessage } from '@/utils/errors'

// ── Identity ──────────────────────────────────────────────────────────────

const TAGLINE = 'The coding agent that shows its work'
const WEBSITE_URL = 'https://openagentd.dev'

function IdentityCard({ version }: { version?: string }) {
  return (
    <SectionCard>
      <div className="flex items-center gap-4 px-4 py-5 sm:px-5">
        <Seal size={56} className="shrink-0 text-(--color-text)" />
        <div className="min-w-0 flex-1">
          <Wordmark height={20} title="OpenAgentd" className="block text-(--color-text)" />
          <p className={cn('mt-0.5 font-mono', TEXT.hint)}>
            {version ? `${TAGLINE} · v${version}` : TAGLINE}
          </p>
          {version && <ReleaseNotesButton className="mt-2" version={version} />}
        </div>
      </div>
    </SectionCard>
  )
}

// ── Version ───────────────────────────────────────────────────────────────

function useClientVersion(): string | undefined {
  const [version, setVersion] = useState<string | undefined>(WEB_BUILD_VERSION)
  useEffect(() => {
    let cancelled = false
    void clientVersion().then((v) => { if (!cancelled && v) setVersion(v) })
    return () => { cancelled = true }
  }, [])
  return version
}

function skewMessage(client: string, server: string): { warn: boolean; text: string } | null {
  const skew = versionSkew(client, server)
  if (skew.kind === 'major-minor') {
    return {
      warn: true,
      text: skew.newer === 'client'
        ? 'The server is older than this app. Update the server to use every feature.'
        : 'This app is older than the server. Update the app to use every feature.',
    }
  }
  if (skew.kind === 'patch') {
    return {
      warn: false,
      text: `Patch versions differ (the ${skew.newer} is newer); they work together.`,
    }
  }
  return null
}

function VersionSection({ client, server }: { client?: string; server?: string }) {
  const address = useBackendStatusQuery().data?.base_url || apiBaseUrl()
  const skew = client && server ? skewMessage(client, server) : null
  const update = useServerUpdateFlow()

  return (
    <PanelSection title="Version" flush>
      <PanelRow label={clientLabel()} description="The app on this device.">
        <span className="font-mono text-sm text-(--color-text)">{client ? `v${client}` : 'unknown'}</span>
      </PanelRow>
      <PanelRow label="Server" description={<span className="font-mono break-all">{address}</span>}>
        <span className="font-mono text-sm text-(--color-text)">{server ? `v${server}` : 'not connected'}</span>
        <ServerUpdateButton onRequest={update.request} />
      </PanelRow>
      <ServerUpdateNote />
      <ServerUpdateConfirm flow={update} />
      {skew ? (
        <p
          role={skew.warn ? 'alert' : 'status'}
          className={cn(
            'flex items-start gap-2 px-4 py-3 sm:px-5',
            TEXT.hint,
            skew.warn && 'text-(--accent-orange-text)',
          )}
        >
          {skew.warn && <AlertTriangle size={14} className="mt-0.5 shrink-0" aria-hidden="true" />}
          <span>{skew.text}</span>
        </p>
      ) : null}
    </PanelSection>
  )
}

// ── Updates ───────────────────────────────────────────────────────────────

function UpdatesSection() {
  const [status, setStatus] = useState<UpdateStatus | null>(null)
  const [pending, setPending] = useState(false)
  const [confirmRestart, setConfirmRestart] = useState(false)
  const mobile = isMobileShell()

  async function onCheck() {
    setPending(true)
    setStatus({ status: 'checking' })
    try {
      setStatus(await checkForUpdates(false))
    } catch (error) {
      setStatus({ status: 'error', message: errorMessage(error) })
    } finally {
      setPending(false)
    }
  }

  async function onDownload() {
    setPending(true)
    try {
      setStatus(await downloadUpdate())
    } catch (error) {
      setStatus({ status: 'error', message: errorMessage(error) })
    } finally {
      setPending(false)
    }
  }

  async function onInstall() {
    setPending(true)
    setStatus((current) => current ? { ...current, status: 'installing' } : { status: 'installing' })
    if (mobile) {
      // Android hands off to the system installer and returns; the system
      // replaces the app if the user confirms.
      try {
        await installUpdate()
        setStatus((current) => current ? { ...current, status: 'downloaded' } : null)
      } catch (error) {
        setStatus({ status: 'error', message: errorMessage(error) })
      } finally {
        setPending(false)
      }
      return
    }
    try {
      const RESTART_TIMEOUT_MS = 60_000
      await Promise.race([
        installUpdate(),
        new Promise<never>((_, reject) =>
          setTimeout(
            () => reject(new Error('Restart timed out. Quit and reopen OpenAgentd.')),
            RESTART_TIMEOUT_MS,
          ),
        ),
      ])
    } catch (error) {
      setStatus({ status: 'error', message: errorMessage(error) })
      setPending(false)
    }
  }

  const showNotes = status?.version && (status.status === 'available' || status.status === 'downloaded')

  return (
    <PanelSection title="Updates" flush>
      <PanelRow
        label={
          <span className="flex items-center gap-2">
            {clientLabel()}
            <span className="rounded-xs border border-(--color-border) bg-(--bg-key) px-1.5 py-0.5 text-meta font-semibold text-(--color-text-muted) select-none">
              {statusTitle(status)}
            </span>
          </span>
        }
        description={
          <>
            <span role="status">{statusDescription(status, mobile)}</span>
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
          <Button size="sm" variant="primary" disabled={pending} onClick={() => setConfirmRestart(true)}>
            {mobile ? 'Install…' : 'Install and restart…'}
          </Button>
        ) : null}
      </PanelRow>
      <ConfirmDialog
        open={confirmRestart}
        onOpenChange={setConfirmRestart}
        tone="default"
        title={mobile ? 'Install the update?' : 'Install and restart OpenAgentd?'}
        description={mobile
          ? 'Android asks you to confirm. OpenAgentd closes while it updates; agents keep running on the server.'
          : 'OpenAgentd restarts to finish the update. Running agents stop.'}
        confirmLabel={mobile ? 'Install' : 'Install and restart'}
        onConfirm={() => { void onInstall() }}
      />
    </PanelSection>
  )
}

function isMobileShell(): boolean {
  const { isTauri, os } = getPlatform()
  return isTauri && (os === 'ios' || os === 'android')
}

function statusTitle(status: UpdateStatus | null): string {
  if (!status) return 'not checked'
  if (status.status === 'checking') return 'checking'
  if (status.status === 'available') return 'update available'
  if (status.status === 'downloaded') return 'ready to install'
  if (status.status === 'installing') return 'installing'
  if (status.status === 'up_to_date') return 'up to date'
  if (status.status === 'error') return 'error'
  return 'not checked'
}

function statusDescription(status: UpdateStatus | null, mobile = false): string {
  if (!status) return 'Check for app updates from here. Automatic checks also run in the background.'
  if (status.message) return status.message
  if (status.status === 'checking') return 'Checking for updates…'
  if (status.status === 'available') {
    return `OpenAgentd ${status.version} is available. Current version: ${status.current_version}.`
  }
  if (status.status === 'downloaded') return `OpenAgentd ${status.version} has been downloaded and is ready to install.`
  if (status.status === 'installing') {
    return mobile ? 'Opening the installer…' : 'Installing the update. OpenAgentd will restart when installation completes.'
  }
  if (status.status === 'up_to_date') return `OpenAgentd ${status.current_version} is the latest version.`
  if (status.status === 'error') return 'Could not check for updates.'
  return 'Check for app updates from here.'
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
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-(--focus-ring)',
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
  const serverVersion = useHealthQuery().data?.version
  const client = useClientVersion()

  return (
    <SettingsPage title="About OpenAgentd">
      <IdentityCard version={client ?? serverVersion} />

      <VersionSection client={client} server={serverVersion} />

      {/* Updates come from the desktop and mobile shells; the browser build has none. */}
      {hasInAppUpdates() && <UpdatesSection />}

      <section aria-labelledby="settings-community-heading" className="space-y-3">
        <div className="select-none">
          <h2 id="settings-community-heading" className={TEXT.title}>Community and support</h2>
          <p className={cn('mt-1', TEXT.hint)}>Ask questions, share what you built, and follow along.</p>
        </div>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <CommunityLink
            href={WEBSITE_URL}
            icon={Globe}
            tint="bg-(--color-accent)/10 text-(--color-accent)"
            title="Website"
            body="Features, downloads, and setup guides at openagentd.dev."
          />
          <CommunityLink
            href="https://discord.gg/cz6GQHQUMg"
            icon={MessageSquare}
            tint="bg-(--bg-key) text-(--color-text-2)"
            title="Discord server"
            body="Join the chat, ask questions, and get help from the community."
          />
          <CommunityLink
            href="https://www.facebook.com/groups/1256361676707935"
            icon={Users}
            tint="bg-(--bg-key) text-(--color-text-2)"
            title="Facebook group"
            body="Connect with other OpenAgentd users and maintainers on Facebook."
          />
          <CommunityLink
            href={PRIVACY_URL}
            icon={Shield}
            tint="bg-(--bg-key) text-(--color-text-2)"
            title="Privacy policy"
            body="What the apps send to your server and the AI providers it uses."
          />
        </div>
      </section>
    </SettingsPage>
  )
}
