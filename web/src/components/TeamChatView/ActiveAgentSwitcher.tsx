import { Check, ChevronDown } from 'lucide-react'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import type { AgentStream } from '@/stores/useTeamStore'
import { dotClassFor } from './agentDots'

export interface ActiveAgentSwitcherProps {
  activeAgent: string
  agents: string[]
  streams: Record<string, AgentStream>
  onSelect: (agent: string) => void
}

export function ActiveAgentSwitcher({
  activeAgent,
  agents,
  streams,
  onSelect,
}: ActiveAgentSwitcherProps) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        data-no-drag
        className="inline-flex h-9 min-w-0 shrink items-center gap-2 rounded-md px-2 font-mono text-xs leading-none font-semibold text-(--color-text) outline-none transition-all hover:bg-(--bg-key) focus-visible:ring-2 focus-visible:ring-(--color-accent)/40 sm:h-auto sm:px-3 sm:py-1.5"
        aria-label={`Switch active agent (current: ${activeAgent})`}
      >
        <span
          className={`h-2 w-2 shrink-0 rounded-full ${dotClassFor(activeAgent, streams[activeAgent])}`}
          aria-hidden="true"
        />
        <span className="min-w-0 truncate">{activeAgent}</span>
        <ChevronDown size={12} className="shrink-0 text-(--color-text-muted)" aria-hidden="true" />
      </DropdownMenuTrigger>

      {/* w-auto overrides w-(--anchor-width) so the menu sizes to its
          content rather than the (narrow) trigger. */}
      <DropdownMenuContent
        align="start"
        sideOffset={6}
        className="w-auto max-w-[min(90vw,24rem)]"
      >
        {agents.map((name) => (
          <DropdownMenuItem
            key={name}
            onClick={() => onSelect(name)}
            className="flex min-w-40 items-center gap-2 font-mono text-xs whitespace-nowrap"
          >
            <span
              className={`h-2 w-2 shrink-0 rounded-full ${dotClassFor(name, streams[name])}`}
              aria-hidden="true"
            />
            <span>{name}</span>
            {name === activeAgent && (
              <Check size={12} className="ml-auto shrink-0 text-(--color-accent)" aria-hidden="true" />
            )}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
