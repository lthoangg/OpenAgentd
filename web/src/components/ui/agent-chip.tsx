/**
 * AgentChip — pill that identifies a canonical agent role.
 *
 * Visual structure (per `.diagrams/OpenAgentd-ui.pen`, components
 * OpenagentdChip / ExecutorChip / ConsultantChip / ExplorerChip):
 *
 *   [● role]
 *
 * - 8×8 colored dot drawn in the role's marker color
 * - mono label
 * - rounded-md badge, padding 6×12, gap 8
 * - active variant: 1.2px border in role's marker color + bold (600) label in `--color-text`
 * - inactive variant: no border, 500-weight label in `--color-text-2`
 *
 * Roles map to marker tokens (NOT chip-soft tokens — the pencil deliberately
 * uses the more saturated marker palette here):
 *   openagentd  → mint    (--color-marker-mint)
 *   executor    → orange  (--color-marker-orange)
 *   consultant  → blue    (--color-marker-blue)
 *   explorer    → muted   (--color-text-muted)
 *
 * The chip is identity-only. For interactive variants pass an `onClick`
 * (the wrapper renders as a `<button>`); read-only variants render a `<span>`.
 */

import { cn } from '@/lib/utils'
import type { AgentRole } from '@/lib/agent-roles'

const CHIP_BASE = 'inline-flex items-center gap-2 rounded-full px-3 py-1.5 font-mono text-xs leading-none transition-all'

const ACTIVE_BORDER: Record<AgentRole, string> = {
  openagentd: 'border-transparent',
  executor:   'border-(--color-marker-orange)',
  consultant: 'border-(--color-marker-blue)',
  explorer:   'border-(--color-text-muted)',
}

function chipVariants({ role = 'openagentd', active = false }: { role?: AgentRole; active?: boolean } = {}): string {
  return cn(
    CHIP_BASE,
    active
      ? cn('border font-semibold text-(--color-text)', ACTIVE_BORDER[role])
      : 'border-transparent font-medium text-(--color-text-2)',
  )
}

const dotColorByRole: Record<AgentRole, string> = {
  openagentd: 'bg-(--color-marker-mint)',
  executor:   'bg-(--color-marker-orange)',
  consultant: 'bg-(--color-marker-blue)',
  explorer:   'bg-(--color-text-muted)',
}

export interface AgentChipProps
  extends Omit<React.ComponentPropsWithoutRef<'button'>, 'role'> {
  role: AgentRole
  active?: boolean
  /** Optional override for the visible label (defaults to the role name). */
  label?: string
  /** Optional override of the dot color when an agent's status diverges from idle. */
  dotClassName?: string
}

export function AgentChip({
  role,
  active = false,
  label,
  dotClassName,
  className,
  onClick,
  ...rest
}: AgentChipProps) {
  const dotClasses = cn('h-2 w-2 shrink-0 rounded-full', dotColorByRole[role], dotClassName)
  const content = (
    <>
      <span className={dotClasses} aria-hidden="true" />
      <span className="min-w-0 truncate">{label ?? role}</span>
    </>
  )

  if (onClick) {
    return (
      <button
        type="button"
        onClick={onClick}
        aria-pressed={Boolean(active)}
        className={cn(chipVariants({ role, active }), className)}
        {...rest}
      >
        {content}
      </button>
    )
  }

  return (
    <span className={cn(chipVariants({ role, active }), className)}>{content}</span>
  )
}
