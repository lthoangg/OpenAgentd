import { useEffect } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import OpenAgentdAppIcon from '@/assets/brand/openagentd-app-icon.png'

import { Wifi, Users, CheckCircle2, AlertCircle } from 'lucide-react'
import { useHealthQuery } from '@/queries/useHealthQuery'
import { useTeamStatusQuery } from '@/queries/useTeamStatusQuery'

interface WelcomeProps {
  onReady: (isTeam: boolean) => void
}

type Step = 'health' | 'team' | 'ready' | 'error'

const STEP_LABELS: Record<Step, string> = {
  health: 'Connecting to backend…',
  team: 'Checking team status…',
  ready: 'Ready',
  error: 'Failed to connect to backend',
}

const STEP_PROGRESS: Record<Step, string> = {
  health: '33%',
  team: '66%',
  ready: '100%',
  error: '0%',
}

export function Welcome({ onReady }: WelcomeProps) {
  const health = useHealthQuery()
  const teamStatus = useTeamStatusQuery()

  useEffect(() => {
    if (health.isSuccess && teamStatus.isSuccess) {
      const timer = setTimeout(() => {
        const isTeam = teamStatus.data !== null
        onReady(isTeam)
      }, 500)
      return () => clearTimeout(timer)
    }
  }, [health.isSuccess, teamStatus.isSuccess, teamStatus.data, onReady])

  const step: Step = health.isError
    ? 'error'
    : !health.isSuccess
      ? 'health'
      : !teamStatus.isSuccess
        ? 'team'
        : 'ready'

  return (
    <div className="flex h-screen flex-col items-center justify-center bg-(--color-bg)">
      <motion.div
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.5, ease: 'easeOut' }}
        className="flex flex-col items-center gap-8 text-center"
      >
        {/* Logo with glow */}
        <div className="relative">
          <div className="absolute inset-0 rounded-3xl bg-(--color-accent-subtle) blur-2xl" />
          <motion.div
            animate={
              step === 'ready'
                ? { scale: [1, 1.06, 1] }
                : { scale: 1 }
            }
            transition={{ duration: 0.5, ease: 'easeInOut' }}
            className="relative flex h-20 w-20 items-center justify-center rounded-3xl bg-(--color-accent-subtle) ring-1 ring-(--color-border-strong)"
          >
            <img src={OpenAgentdAppIcon} width={72} height={72} alt="OpenAgentd logo" className="rounded-2xl" />
          </motion.div>
        </div>

        {/* Wordmark */}
        <div>
          <h1 className="text-4xl font-bold tracking-tight text-(--color-text)">
            OpenAgentd
          </h1>
          <p className="mt-2 text-sm text-(--color-text-muted)">
            Your on-machine AI assistant
          </p>
        </div>

        {/* Progress */}
        <div className="flex w-56 flex-col items-center gap-3">
          {/* Progress bar */}
          <div className="h-0.5 w-full overflow-hidden rounded-full bg-(--color-accent-subtle)">
            <motion.div
              className={`h-full rounded-full ${
                step === 'error'
                  ? 'bg-(--color-error)'
                  : 'bg-(--color-accent)'
              }`}
              initial={{ width: '0%' }}
              animate={{ width: STEP_PROGRESS[step] }}
              transition={{ duration: 0.4, ease: 'easeOut' }}
            />
          </div>

          {/* Step indicators */}
          <div className="flex items-center gap-3">
            <StepIcon
              icon={Wifi}
              done={health.isSuccess}
              active={step === 'health'}
              error={step === 'error'}
              label="Backend"
            />
            <div className="h-px w-4 bg-(--color-accent-subtle)" />
            <StepIcon
              icon={Users}
              done={teamStatus.isSuccess}
              active={step === 'team'}
              error={false}
              label="Team"
            />
            <div className="h-px w-4 bg-(--color-accent-subtle)" />
            <StepIcon
              icon={CheckCircle2}
              done={step === 'ready'}
              active={false}
              error={false}
              label="Ready"
            />
          </div>

          {/* Status text */}
          <AnimatePresence mode="wait">
            <motion.p
              key={step}
              initial={{ opacity: 0, y: 4 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -4 }}
              transition={{ duration: 0.25 }}
              className={`text-sm ${
                step === 'error'
                  ? 'text-(--color-error)'
                  : step === 'ready'
                    ? 'text-(--color-success)'
                    : 'text-(--color-text-muted)'
              }`}
            >
              {step === 'ready' && teamStatus.data
                ? `✓ Team mode · ${[teamStatus.data.lead, ...teamStatus.data.members].length} agents`
                : STEP_LABELS[step]}
            </motion.p>
          </AnimatePresence>
        </div>
      </motion.div>
    </div>
  )
}

function StepIcon({
  icon: Icon,
  done,
  active,
  error,
  label,
}: {
  icon: React.ComponentType<{ size?: number; className?: string }>
  done: boolean
  active: boolean
  error: boolean
  label: string
}) {
  return (
    <div className="flex flex-col items-center gap-1" title={label}>
      <div
        className={`flex h-7 w-7 items-center justify-center rounded-full transition-all ${
          error
            ? 'bg-(--color-error-subtle) text-(--color-error)'
            : done
              ? 'bg-(--color-success-subtle) text-(--color-success)'
              : active
                ? 'bg-(--color-accent-subtle) text-(--color-accent)'
                : 'bg-(--color-accent-dim) text-(--color-text-muted)'
        }`}
      >
        {error ? (
          <AlertCircle size={14} />
        ) : (
          <Icon size={14} className={active ? 'animate-pulse' : ''} />
        )}
      </div>
    </div>
  )
}
