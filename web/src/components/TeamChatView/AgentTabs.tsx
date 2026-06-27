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
    <div className="scrollbar-none flex shrink-0 items-center gap-1 border-b border-(--color-border) bg-(--bg-sidebar) px-3 py-1.5 overflow-x-auto">
      {agents.map((name) => {
        const isActive = name === activeAgent
        const stream = streams[name]

        return (
          <button
            key={name}
            type="button"
            onClick={() => onSelect(name)}
            className={`flex items-center gap-1.5 rounded-xs border border-transparent px-2.5 py-1 font-mono text-[10px] font-semibold tracking-wide uppercase transition-colors outline-none ${
              isActive
                ? 'border-(--color-border-strong) bg-(--bg-key) text-(--color-text)'
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
