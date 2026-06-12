/**
 * AgentTopbar — right-cluster composite for the chat header.
 *
 * Layout: dream pulse · tokens · view toggle · todos/files/wiki etc.
 * Props-driven so previews and future single-agent surfaces can reuse
 * it without pulling in TeamChatView's stores. Design source:
 * `AgentTopbar` (`E8lml9`) in `.diagrams/OpenAgentd-ui.pen`.
 */

import {
  Brain,
  CalendarClock,
  FolderOpen,
  ListChecks,
  Moon,
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
  /** Show "Dream…" indicator when the dream loop is running. */
  dreamRunning?: boolean
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
  /** Scheduler action — opens the scheduled-tasks drawer (Ctrl+S). */
  schedulerAction?: AgentTopbarActionDescriptor
  /** Wiki action — opens the wiki drawer (Ctrl+M). */
  wikiAction?: AgentTopbarActionDescriptor
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
  dreamRunning = false,
  viewMode,
  onViewModeChange,
  isMobile = false,
  todosSlot,
  todosAction,
  schedulerAction,
  wikiAction,
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
        'flex shrink-0 items-center gap-0.5 py-0.5 md:gap-1.5 md:py-2',
        className,
      )}
    >
      {dreamRunning && (
        <div
          className="flex items-center gap-1 rounded-md px-2 py-1 text-xs text-(--color-text-muted)"
          title="Dream is running…"
        >
          <Moon size={11} className="animate-pulse" aria-hidden="true" />
          <span className="hidden sm:inline">Dream…</span>
        </div>
      )}

      {showTokens && tokens && (
        <TokenMeter
          input={tokens.input}
          output={tokens.output}
          cached={tokens.cached}
          trigger={tokens.trigger}
          pulsing={tokens.pulsing}
        />
      )}

      {showViewToggle && viewMode && onViewModeChange && (
        <ViewToggle value={viewMode} onValueChange={onViewModeChange} />
      )}

      {todosSlot ?? (todosAction && <AgentTopbarActionButton action={todosAction} fallbackIcon={ListChecks} />)}
      {schedulerAction && (
        <AgentTopbarActionButton action={schedulerAction} fallbackIcon={CalendarClock} />
      )}
      {wikiAction && (
        <AgentTopbarActionButton action={wikiAction} fallbackIcon={Brain} />
      )}
      {filesAction && (
        <AgentTopbarActionButton action={filesAction} fallbackIcon={FolderOpen} />
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
