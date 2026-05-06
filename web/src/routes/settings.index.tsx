/**
 * /settings — welcome / overview panel shown in the right pane when no
 * category is active. The left rail is always visible; this page just
 * gives the user a friendly summary and quick jumps with live counts.
 */
import { Link } from '@tanstack/react-router'
import {
  ArrowLeft,
  ChevronRight,
  Download,
  Mic,
  Moon,
  Plug,
  RefreshCw,
  Settings as SettingsIcon,
  Shield,
  Sparkles,
  Wrench,
  type LucideIcon,
} from 'lucide-react'

import { cn } from '@/lib/utils'
import { useIsMobile } from '@/hooks/use-mobile'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import {
  useAgentFilesQuery,
  useHealthQuery,
  useInstallUpdateMutation,
  useMcpServersQuery,
  useSandboxSettingsQuery,
  useSkillFilesQuery,
  useSpeechConfigQuery,
  useUpdateStatusQuery,
} from '@/queries'
import { useToastStore } from '@/stores/useToastStore'

interface CardProps {
  to: '/settings/agents' | '/settings/skills' | '/settings/mcp' | '/settings/sandbox' | '/settings/dream' | '/settings/voice'
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
        'group flex items-center gap-4 rounded-xl border border-border bg-card/40 p-4 transition-all',
        'hover:border-border/80 hover:bg-card focus-visible:border-ring focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/40',
      )}
    >
      <span
        className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground ring-1 ring-border transition-colors group-hover:text-foreground"
        aria-hidden="true"
      >
        <Icon size={18} />
      </span>

      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate text-sm font-semibold">{title}</span>
          <span className="rounded-full bg-muted px-2 py-0.5 font-mono text-[10px] tabular-nums text-muted-foreground">
            {count === null ? '–' : count} {countLabel}
          </span>
        </div>
        <p className="mt-0.5 truncate text-xs text-muted-foreground">{description}</p>
      </div>

      <ChevronRight
        size={16}
        className="shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5 group-hover:text-foreground"
        aria-hidden="true"
      />
    </Link>
  )
}

export function SystemUpdateCard() {
  const healthQ = useHealthQuery()
  const updateQ = useUpdateStatusQuery()
  const installMut = useInstallUpdateMutation()
  const push = useToastStore((s) => s.push)
  const status = updateQ.data
  const currentVersion = status?.current_version ?? healthQ.data?.version

  const handleCheck = async () => {
    try {
      const result = await updateQ.refetch()
      if (result.error) throw result.error
      const data = result.data
      if (!data) return
      push({
        tone: data.update_available ? 'info' : 'success',
        title: data.update_available ? `New update v${data.latest_version}` : 'OpenAgentd is up to date',
        description: `Current version: v${data.current_version}`,
      })
    } catch (err) {
      push({
        tone: 'error',
        title: 'Update check failed',
        description: err instanceof Error ? err.message : String(err),
      })
    }
  }

  const handleInstall = async () => {
    try {
      await installMut.mutateAsync()
      push({
        tone: 'success',
        title: 'Update started',
        description: 'OpenAgentd will install the update and restart in the background.',
      }, 8000)
    } catch (err) {
      push({
        tone: 'error',
        title: 'Install failed',
        description: err instanceof Error ? err.message : String(err),
      })
    }
  }

  return (
    <Card size="sm" className="border-border bg-card/40">
      <CardHeader className="gap-2 sm:grid-cols-[1fr_auto]">
        <div>
          <CardTitle>Application update</CardTitle>
          <CardDescription>
            Check for a published OpenAgentd release and install it from here.
          </CardDescription>
        </div>
        <Button
          size="sm"
          variant="outline"
          onClick={handleCheck}
          disabled={updateQ.isFetching || installMut.isPending}
          className="justify-self-start sm:justify-self-end"
        >
          <RefreshCw size={13} className={cn(updateQ.isFetching && 'animate-spin')} aria-hidden="true" />
          {updateQ.isFetching ? 'Checking...' : 'Check for updates'}
        </Button>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="rounded-lg bg-muted/50 p-3 text-xs text-muted-foreground ring-1 ring-border/70">
          <div className="flex flex-wrap items-center gap-2">
            <span>Current version:</span>
            <span className="font-mono text-foreground">
              {currentVersion ? `v${currentVersion}` : 'Not checked'}
            </span>
            {status?.latest_version && (
              <>
                <span>Latest:</span>
                <span className="font-mono text-foreground">v{status.latest_version}</span>
              </>
            )}
          </div>
          {updateQ.error && (
            <p className="mt-2 text-destructive">
              {updateQ.error instanceof Error ? updateQ.error.message : String(updateQ.error)}
            </p>
          )}
          {status?.install_blocked_reason && (
            <p className="mt-2">{status.install_blocked_reason}</p>
          )}
        </div>

        {status?.update_available && (
          <div className="flex flex-col gap-2 rounded-lg border border-primary/20 bg-primary/5 p-3 sm:flex-row sm:items-center sm:justify-between">
            <p className="text-sm font-medium text-foreground">
              New update v{status.latest_version} is available.
            </p>
            <Button
              size="sm"
              onClick={handleInstall}
              disabled={!status.can_install || installMut.isPending}
            >
              <Download size={13} aria-hidden="true" />
              {installMut.isPending ? 'Starting...' : 'Install'}
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  )
}

function SectionHeader({ children }: { children: string }) {
  return (
    <h2 className="mb-2 px-1 text-[11px] font-medium tracking-wider text-muted-foreground uppercase">
      {children}
    </h2>
  )
}

export function SettingsHubPage() {
  const isMobile = useIsMobile()
  const agentsQ = useAgentFilesQuery()
  const skillsQ = useSkillFilesQuery()
  const mcpQ = useMcpServersQuery()
  const sandboxQ = useSandboxSettingsQuery()
  const speechQ = useSpeechConfigQuery()

  const agentsCount = agentsQ.data?.agents.length ?? null
  const skillsCount = skillsQ.data?.skills.length ?? null
  const mcpCount = mcpQ.data?.servers.length ?? null
  const sandboxCount = sandboxQ.data?.denied_patterns.length ?? null
  const voiceEnabled = speechQ.data?.enabled ?? false

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto max-w-3xl space-y-8 p-4 md:p-8">
        <header className="flex items-center gap-3">
          {/* Mobile: back to cockpit */}
          {isMobile && (
            <Link
              to="/cockpit"
              aria-label="Back to chat"
              className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            >
              <ArrowLeft size={16} aria-hidden="true" />
            </Link>
          )}
          <span
            className="flex h-10 w-10 items-center justify-center rounded-xl bg-muted text-muted-foreground ring-1 ring-border"
            aria-hidden="true"
          >
            <SettingsIcon size={18} />
          </span>
          <div>
            <h1 className="text-lg font-semibold">Settings</h1>
            <p className="text-xs text-muted-foreground">
              Configure your workspace and the agents that run in it.
            </p>
          </div>
        </header>

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
              to="/settings/dream"
              icon={Moon}
              title="Dream"
              description="Cron agent that synthesises sessions into wiki topics"
              count={null}
              countLabel=""
            />
            <SettingsNavCard
              to="/settings/voice"
              icon={Mic}
              title="Voice input"
              description="Transcribe mic recordings locally and insert into the chat input"
              count={null}
              countLabel={voiceEnabled ? 'enabled' : 'disabled'}
            />
          </div>
        </section>

        <section>
          <SectionHeader>Updates</SectionHeader>
          <SystemUpdateCard />
        </section>
      </div>
    </div>
  )
}
