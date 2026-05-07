import { motion } from 'framer-motion'
import { useNavigate } from '@tanstack/react-router'
import OpenAgentdAppIcon from '@/assets/brand/openagentd-app-icon.png'

import { Activity, AlertCircle, Gauge, Settings, Wifi } from 'lucide-react'
import { useHealthQuery } from '@/queries/useHealthQuery'
import { useTeamStatusQuery } from '@/queries/useTeamStatusQuery'

export function HomePage() {
  const navigate = useNavigate()
  const health = useHealthQuery()
  const team = useTeamStatusQuery()

  const backendOk = health.isSuccess
  const hasTeam = team.isSuccess && team.data !== null
  const loading = health.isLoading || team.isLoading
  const error = health.isError

  return (
    <div className="flex h-screen flex-col items-center justify-center bg-(--color-bg) px-4">
      <motion.div
        initial={{ opacity: 0, y: 24 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.45, ease: 'easeOut' }}
        className="flex w-full max-w-sm flex-col items-center gap-8"
      >
        {/* Logo */}
        <div className="flex flex-col items-center gap-4">
          <div className="relative">
            <div className="absolute inset-0 rounded-3xl bg-(--color-accent-subtle) blur-2xl" />
            <div className="relative flex h-20 w-20 items-center justify-center rounded-3xl bg-(--color-accent-subtle) ring-1 ring-(--color-accent-subtle)">
              <img src={OpenAgentdAppIcon} width={72} height={72} alt="OpenAgentd logo" className="rounded-2xl" />
            </div>
          </div>
          <div className="text-center">
            <h1 className="text-3xl font-bold tracking-tight text-(--color-text)">
              OpenAgentd
            </h1>
            <p className="mt-1 text-sm text-(--color-text-muted)">
              Your on-machine AI assistant
            </p>
          </div>
        </div>

        {/* Mode picker */}
        <div className="flex w-full flex-col gap-3">
          <ModeCard
            icon={Gauge}
            title="Cockpit"
            description={
              loading && !error
                ? 'Checking team…'
                : hasTeam
                  ? `${[team.data!.lead, ...team.data!.members].length} agents ready`
                  : 'No team configured'
            }
            disabled={!backendOk || !hasTeam}
            loading={loading && !error}
            onClick={() => navigate({ to: '/cockpit' })}
          />
           <ModeCard
             icon={Activity}
             title="Telemetry"
             description="Span aggregates & latency"
             disabled={!backendOk}
             loading={loading && !error}
             onClick={() => navigate({ to: '/telemetry' })}
           />
           <ModeCard
             icon={Settings}
             title="Settings"
             description="Agents, skills, MCP servers, sandbox"
             disabled={!backendOk}
             loading={loading && !error}
             onClick={() => navigate({ to: '/settings' })}
           />
        </div>

        {/* Backend status */}
        <div className="flex items-center gap-2 text-xs">
          {loading && !error ? (
            <span className="animate-pulse text-(--color-text-muted)">Connecting…</span>
          ) : error ? (
            <>
              <AlertCircle size={12} className="text-(--color-error)" />
              <span className="text-(--color-error)">Backend unreachable</span>
            </>
          ) : (
            <>
              <Wifi size={12} className="text-(--color-success)" />
              <span className="text-(--color-text-muted)">Connected</span>
            </>
          )}
        </div>
      </motion.div>
    </div>
  )
}

function ModeCard({
  icon: Icon,
  title,
  description,
  disabled,
  loading,
  onClick,
}: {
  icon: React.ComponentType<{ size?: number; className?: string }>
  title: string
  description: string
  disabled: boolean
  loading: boolean
  onClick: () => void
}) {
  return (
    <motion.button
      whileHover={disabled ? {} : { scale: 1.015 }}
      whileTap={disabled ? {} : { scale: 0.985 }}
      onClick={disabled ? undefined : onClick}
      disabled={disabled}
      className={`flex w-full items-center gap-4 rounded-2xl border px-5 py-4 text-left transition-all ${
        disabled
          ? 'cursor-not-allowed border-(--color-accent-dim) bg-(--color-accent-dim) opacity-40'
          : 'border-(--color-accent-subtle) bg-(--color-surface-2) hover:border-(--color-border-strong) hover:bg-(--color-accent-dim)'
      }`}
    >
      <div
        className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-xl ${
          disabled
            ? 'bg-(--color-accent-dim)'
            : 'bg-(--color-accent-subtle) ring-1 ring-(--color-border-strong)'
        }`}
      >
        <Icon
          size={18}
          className={
            disabled
              ? 'text-(--color-text-muted)'
              : loading
                ? 'animate-pulse text-(--color-accent)'
                : 'text-(--color-accent)'
          }
        />
      </div>
      <div className="min-w-0">
        <p className="text-sm font-semibold text-(--color-text)">{title}</p>
        <p className="mt-0.5 text-xs text-(--color-text-muted)">{description}</p>
      </div>
    </motion.button>
  )
}
