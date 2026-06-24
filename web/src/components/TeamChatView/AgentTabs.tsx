import type { AgentStream } from '@/stores/useTeamStore'
import { dotClassFor } from './agentDots'

export interface AgentTabsProps {
  activeAgent: string
  agents: string[]
  streams: Record<string, AgentStream>
  onSelect: (agent: string) => void
}

export function AgentTabs({
  activeAgent,
  agents,
  streams,
  onSelect,
}: AgentTabsProps) {
  return (
    <div className="scrollbar-none flex shrink-0 items-center gap-1.5 border-b border-(--color-border) bg-(--bg-page) px-3 py-1.5 overflow-x-auto">
      {agents.map((name) => {
        const isActive = name === activeAgent
        const stream = streams[name]

        return (
          <button
            key={name}
            type="button"
            onClick={() => onSelect(name)}
            className={`flex items-center gap-1.5 rounded-full px-3 py-1 font-mono text-[10px] font-semibold tracking-wide uppercase transition-all outline-none ${
              isActive
                ? 'bg-(--bg-key) text-(--color-text) ring-1 ring-(--color-border-strong)'
                : 'text-(--color-text-subtle) hover:bg-(--bg-key)/40 hover:text-(--color-text-2)'
            }`}
          >
            <span
              className={`h-1.5 w-1.5 shrink-0 rounded-full ${dotClassFor(name, stream)}`}
              aria-hidden="true"
            />
            <span className="min-w-0 truncate">{name}</span>
          </button>
        )
      })}
    </div>
  )
}
