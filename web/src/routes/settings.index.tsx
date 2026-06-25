/**
 * /settings — "About openagentd" landing.
 *
 * Desktop hides the sidebar category list (the rail already shows them);
 * mobile re-uses this page as the settings hub by rendering nav cards.
 *
 */
import { useState } from 'react'
import { Link } from '@tanstack/react-router'
import {
  Bell,
  ChevronRight,
  Server,
  Download,
  Info,
  Image,
  KeyRound,
  Plug,
  Shield,
  Sparkles,
  Type,
  Wrench,
  type LucideIcon,
} from 'lucide-react'

import { AppBackendDialog } from '@/components/AppBackendDialog'
import { checkForUpdates, downloadUpdate, fetchReleaseNotes, installUpdate, type ReleaseNotes, type UpdateStatus } from '@/lib/updater'
import { openExternalUrl } from '@/lib/open-external'
import { cn } from '@/lib/utils'
import { MarkdownBlock } from '@/utils/markdown'
import { useIsMobile } from '@/hooks/use-mobile'
import {
  useAgentFilesQuery,
  useHealthQuery,
  useMcpServersQuery,
  useProvidersQuery,
  useSandboxSettingsQuery,
  useSkillFilesQuery,
} from '@/queries'

interface CardProps {
  to:
    | '/settings/agents'
    | '/settings/skills'
    | '/settings/mcp'
    | '/settings/providers'
    | '/settings/multimodal'
  | '/settings/sandbox'
  | '/settings/title-generation'
    | '/settings/notifications'
  icon: LucideIcon
  title: string
  description: string
  count: number | null
  countLabel: string
}

function SettingsNavCard({ to, icon: Icon, title, description, count, countLabel }: CardProps) {
  return (
    <Link
      to={to}
      className={cn(
        'group flex items-start gap-3 rounded-xl border border-(--color-border) bg-(--bg-card) p-4 text-(--color-text) transition-colors sm:items-center sm:gap-4',
        'hover:border-(--color-border-strong) hover:bg-(--color-surface)',
        'focus-visible:border-(--focus-ring) focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-(--focus-ring)/40',
      )}
    >
      <span
        className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md bg-(--bg-key) text-(--color-text-muted) ring-1 ring-(--color-border) transition-colors group-hover:text-(--color-text)"
        aria-hidden="true"
      >
        <Icon size={18} />
      </span>

      <div className="min-w-0 flex-1">
        <div className="flex flex-col gap-1 sm:flex-row sm:items-center sm:gap-2">
          <span className="text-sm font-semibold text-(--color-text)">{title}</span>
          <span className="w-fit rounded-md bg-(--bg-key) px-2 py-0.5 font-mono text-[10px] tabular-nums text-(--color-text-muted)">
            {count === null ? '–' : count} {countLabel}
          </span>
        </div>
        <p className="mt-1 text-xs leading-5 text-(--color-text-muted) sm:truncate">{description}</p>
      </div>

      <ChevronRight
        size={16}
        className="shrink-0 text-(--color-text-muted) transition-transform group-hover:translate-x-0.5 group-hover:text-(--color-text)"
        aria-hidden="true"
      />
    </Link>
  )
}

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
      await installUpdate()
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
        <div className="mobile-safe-overlay fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" role="dialog" aria-modal="true" aria-label="Release notes" onClick={() => setNotesOpen(false)}>
          <div className="max-h-[min(32rem,calc(100dvh-env(safe-area-inset-top,0px)-env(safe-area-inset-bottom,0px)-2rem))] w-full max-w-lg overflow-hidden rounded-md border border-(--color-border) bg-(--bg-card) text-(--color-text) shadow-2xl" onClick={(event) => event.stopPropagation()}>
            <div className="flex items-center justify-between gap-3 border-b border-(--color-border) px-4 py-3">
              <h3 className="text-sm font-semibold">Release notes</h3>
              <div className="flex items-center gap-2">
                {releaseNotes?.url ? <a className="rounded-md px-2 py-1 text-xs text-(--color-accent) hover:bg-(--bg-page)" href={releaseNotes.url} target="_blank" rel="noopener noreferrer" onClick={(event) => { event.preventDefault(); void openExternalUrl(releaseNotes.url!) }}>View in GitHub</a> : null}
                <button className="rounded-md px-2 py-1 text-xs text-(--color-text-muted) hover:bg-(--bg-page)" onClick={() => setNotesOpen(false)}>Close</button>
              </div>
            </div>
            <div className="max-h-[24rem] overflow-y-auto px-4 py-3 text-(--color-text)">
              <MarkdownBlock content={`${releaseNotes?.body ?? status.notes ?? 'Loading release notes...'}${releaseNotesError ? `\n\nCould not load GitHub release notes: ${releaseNotesError}` : ''}`} />
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

function SectionHeader({ children }: { children: string }) {
  return (
    <h2 className="mb-2 px-1 text-[11px] font-medium tracking-wider text-(--color-text-muted) uppercase">
      {children}
    </h2>
  )
}

export function SettingsHubPage() {
  const isMobile = useIsMobile()
  const agentsQ = useAgentFilesQuery()
  const skillsQ = useSkillFilesQuery()
  const mcpQ = useMcpServersQuery()
  const providersQ = useProvidersQuery()
  const sandboxQ = useSandboxSettingsQuery()
  const healthQ = useHealthQuery()
  const [backendDialogOpen, setBackendDialogOpen] = useState(false)

  const agentsCount = agentsQ.data?.agents.length ?? null
  const skillsCount = skillsQ.data?.skills.length ?? null
  const mcpCount = mcpQ.data?.servers.length ?? null
  const connectedProvidersCount = providersQ.data?.providers.filter((provider) => provider.is_configured).length ?? null
  const sandboxCount = sandboxQ.data?.denied_patterns.length ?? null
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

        {/* Mobile picks up navigation from this list because the sidebar is
            hidden on small screens. */}
        {isMobile && (
          <>
            <section>
              <SectionHeader>Workspace</SectionHeader>
              <div className="space-y-2">
                <SettingsNavCard
                  to="/settings/agents"
                  icon={Wrench}
                  title="Agents"
                  description="Define and edit your agent team — model, tools, system prompt"
                  count={agentsCount}
                  countLabel={agentsCount === 1 ? 'agent' : 'agents'}
                />
                <SettingsNavCard
                  to="/settings/skills"
                  icon={Sparkles}
                  title="Skills"
                  description="Reusable instruction modules agents load on demand"
                  count={skillsCount}
                  countLabel={skillsCount === 1 ? 'skill' : 'skills'}
                />
                <SettingsNavCard
                  to="/settings/mcp"
                  icon={Plug}
                  title="MCP servers"
                  description="External tool providers via Model Context Protocol"
                  count={mcpCount}
                  countLabel={mcpCount === 1 ? 'server' : 'servers'}
                />
                <SettingsNavCard
                  to="/settings/providers"
                  icon={KeyRound}
                  title="Providers"
                  description="Configure API keys and OAuth model providers"
                  count={connectedProvidersCount}
                  countLabel="connected"
                />
              </div>
            </section>

            <section>
              <SectionHeader>System</SectionHeader>
              <div className="space-y-2">
                <SettingsNavCard
                  to="/settings/sandbox"
                  icon={Shield}
                  title="Sandbox"
                  description="Files and folders agents cannot access"
                  count={sandboxCount}
                  countLabel={sandboxCount === 1 ? 'pattern' : 'patterns'}
                />
                <SettingsNavCard
                  to="/settings/multimodal"
                  icon={Image}
                  title="Multimodal"
                  description="Configure image and video generation defaults"
                  count={null}
                  countLabel=""
                />
                <SettingsNavCard
                  to="/settings/title-generation"
                  icon={Type}
                  title="Title generation"
                  description="Configure automatic chat title model and latency"
                  count={null}
                  countLabel=""
                />
                <SettingsNavCard
                  to="/settings/notifications"
                  icon={Bell}
                  title="Notifications"
                  description="Control desktop notifications and send a test notification"
                  count={null}
                  countLabel=""
                />
              </div>
            </section>
          </>
        )}
      </div>
    </div>
  )
}
