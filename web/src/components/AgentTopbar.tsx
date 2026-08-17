/**
 * AgentTopbar — right-cluster composite for the chat header.
 *
 * Layout: tokens · view toggle · todos/files/agents etc.
 * Props-driven so previews and future single-agent surfaces can reuse
 * it without pulling in TeamChatView's stores. Design source:
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
import { ViewToggle, type ViewMode } from '@/components/ui/view-toggle'
import { cn } from '@/lib/utils'

export interface AgentTopbarTokens {
  input: number
  output: number
  cached?: number
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
  className?: string
}

export interface AgentTopbarProps {
  /** Token totals; when omitted (or all zero) the TokenMeter is hidden. */
  tokens?: AgentTopbarTokens
  /** Current view mode; when undefined the ViewToggle is hidden. */
  viewMode?: ViewMode
  onViewModeChange?: (mode: ViewMode) => void
  /** Force the mobile/desktop layout. Defaults to desktop. */
  isMobile?: boolean
  /**
   * Custom Todos trigger. The TodosPopover handles its own trigger
   * (open state, popover wiring), so the consumer passes the rendered
   * trigger element. When omitted the topbar renders a plain Todos
   * action driven by `onTodosClick`.
   */
  todosSlot?: React.ReactNode
  todosAction?: AgentTopbarActionDescriptor
  /** Scheduler action — opens the scheduled-tasks drawer (⌘S / Ctrl+S). */
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
  viewMode,
  onViewModeChange,
  isMobile = false,
  todosSlot,
  todosAction,
  schedulerAction,
  filesAction,
  agentsAction,
  extraActions,
  className,
}: AgentTopbarProps) {
  const totalAll = tokens
    ? tokens.input + tokens.output + (tokens.cached ?? 0)
    : 0
  const showTokens = !isMobile && tokens && totalAll > 0
  const showViewToggle = !isMobile && viewMode && onViewModeChange

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
          sessionCostUsd={tokens.sessionCostUsd}
          trigger={tokens.trigger}
          pulsing={tokens.pulsing}
          className="mr-0.5"
        />
      )}

      {showViewToggle && viewMode && onViewModeChange && (
        <ViewToggle value={viewMode} onValueChange={onViewModeChange} />
      )}

      {todosSlot ?? (todosAction && <AgentTopbarActionButton action={todosAction} fallbackIcon={ListChecks} />)}
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
  return (
    <TopbarAction
      Icon={Icon}
      label={action.label}
      onClick={action.onClick}
      disabled={action.disabled}
      className={action.className}
      title={action.title}
      aria-label={action.ariaLabel ?? action.label ?? action.title}
      indicator={action.indicator}
      indicatorClassName={action.indicatorClassName}
    />
  )
}
