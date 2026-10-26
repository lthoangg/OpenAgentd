/**
 * AgentTopbar — right-cluster composite for the chat header.
 *
 * Layout: tokens · view toggle · todos/files/agents etc.
 * Props-driven so previews and future single-agent surfaces can reuse
 * it without pulling in AgentChatView's stores. Design source:
 * `AgentTopbar` (`E8lml9`) in `.diagrams/OpenAgentd-ui.pen`.
 */

import {
  CalendarClock,
  ListChecks,
  PanelRight,
  Users,
  type LucideIcon,
} from 'lucide-react'

import { TopbarAction } from '@/components/ui/topbar-action'
import { TokenMeter } from '@/components/ui/token-meter'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import type { GoalTone } from '@/lib/goal'

export interface AgentTopbarTokens {
  input: number
  output: number
  cached?: number
  cachedPercent?: number
  sessionCostUsd?: number
  trigger?: number
  pulsing?: boolean
}

export interface AgentTopbarActionDescriptor {
  /** Lucide icon component. */
  Icon: LucideIcon
  label?: string
  onClick: () => void
  /** Disable the action (renders muted, blocks click). */
  disabled?: boolean
  /** Native `title` attribute / tooltip text. */
  title?: string
  /** Override default aria-label. */
  ariaLabel?: string
  /** Show a small accent dot to signal an active/in-progress state. */
  indicator?: boolean
  /** Override the indicator dot color (e.g. error red). */
  indicatorClassName?: string
  /** A goal's ring beside the badge, in the colour of its status. */
  goalTone?: GoalTone
  /** Toggle state for panel toggles; rendered as ``aria-pressed``. */
  pressed?: boolean
  /** Short trailing text such as task progress (``"2/5"``). */
  badge?: string
  className?: string
}

export interface AgentTopbarProps {
  /** Token totals; when omitted the TokenMeter is hidden. */
  tokens?: AgentTopbarTokens
  /** Force the mobile/desktop layout. Defaults to desktop. */
  isMobile?: boolean
  todosAction?: AgentTopbarActionDescriptor
  /** Scheduler action — opens the scheduled-tasks drawer. */
  schedulerAction?: AgentTopbarActionDescriptor
  /** Files action — typically toggles the workspace files panel. */
  filesAction?: AgentTopbarActionDescriptor
  /** Agents action — typically toggles the agent capabilities sidebar. */
  agentsAction?: AgentTopbarActionDescriptor
  /** Extra actions appended after Agents (rarely needed). */
  extraActions?: React.ReactNode
  className?: string
}

/**
 * Right-side cluster of the agent chat topbar. Always rendered as a
 * shrink-0 flex row so it can sit at the trailing edge of a `min-w-0`
 * left side.
 */
export function AgentTopbar({
  tokens,
  isMobile = false,
  todosAction,
  schedulerAction,
  filesAction,
  agentsAction,
  extraActions,
  className,
}: AgentTopbarProps) {
  const showTokens = !isMobile && Boolean(tokens)

  return (
    <div
      className={cn(
        // py-0 keeps the element within the compact app header on desktop so the
        // AgentTopbar never grows the header's intrinsic height —
        // an oversized header confuses AppKit's titlebar measurement
        // and pushes the macOS traffic lights off-centre.
        'flex shrink-0 items-center gap-0.5 py-0 md:gap-1.5 md:py-0',
        className,
      )}
    >
      {showTokens && tokens && (
        <TokenMeter
          input={tokens.input}
          output={tokens.output}
          cached={tokens.cached}
          cachedPercent={tokens.cachedPercent}
          sessionCostUsd={tokens.sessionCostUsd}
          trigger={tokens.trigger}
          pulsing={tokens.pulsing}
          className="mr-0.5"
        />
      )}

      {todosAction && <AgentTopbarActionButton action={todosAction} fallbackIcon={ListChecks} />}
      {schedulerAction && (
        <AgentTopbarActionButton action={schedulerAction} fallbackIcon={CalendarClock} />
      )}
      {filesAction && (
        <AgentTopbarActionButton action={filesAction} fallbackIcon={PanelRight} />
      )}
      {agentsAction && (
        <AgentTopbarActionButton action={agentsAction} fallbackIcon={Users} />
      )}

      {extraActions}
    </div>
  )
}

function AgentTopbarActionButton({
  action,
  fallbackIcon,
}: {
  action: AgentTopbarActionDescriptor
  fallbackIcon: LucideIcon
}) {
  const Icon = action.Icon ?? fallbackIcon
  const button = (
    <TopbarAction
      Icon={Icon}
      label={action.label}
      onClick={action.onClick}
      disabled={action.disabled}
      className={action.className}
      aria-label={action.ariaLabel ?? action.label ?? action.title}
      indicator={action.indicator}
      indicatorClassName={action.indicatorClassName}
      goalTone={action.goalTone}
      badge={action.badge}
      aria-pressed={action.pressed}
    />
  )
  if (!action.title) return button
  return (
    <Tooltip>
      <TooltipTrigger render={button} />
      <TooltipContent>{action.title}</TooltipContent>
    </Tooltip>
  )
}
