/**
 * AgentTopbarPreview — composite preview matching the two pencil
 * variants in the right-cluster section `BbrKe`:
 *
 *   1. Default — agent view, no token meter
 *   2. Working — agent view, token meter pulsing
 *
 * The component is preview-only so it owns its own viewMode state and
 * the actions are no-ops.
 */

import { useState } from 'react'
import { ListChecks, PanelRight, Users } from 'lucide-react'

import { AgentTopbar } from '@/components/AgentTopbar'
import type { ViewMode } from '@/components/ui/view-toggle'

function PreviewFrame({
  title,
  description,
  children,
}: {
  title: string
  description: string
  children: React.ReactNode
}) {
  return (
    <div className="rounded-[10px] border border-(--color-border) bg-(--bg-page)">
      <div className="border-b border-(--color-border) px-4 py-2">
        <h3 className="font-mono text-xs font-semibold uppercase tracking-wider text-(--color-text-2)">
          {title}
        </h3>
        <p className="text-xs text-(--color-text-muted)">{description}</p>
      </div>
      {/* Mock left-cluster filler so the right cluster sits at the trailing edge,
          mirroring the production header layout. */}
      <header className="flex items-center gap-1.5 px-4">
        <div className="min-w-0 flex-1 truncate text-xs text-(--color-text-muted)">
          ← left cluster (agent tabs / split label)
        </div>
        {children}
      </header>
    </div>
  )
}

export function AgentTopbarPreview() {
  const [defaultMode, setDefaultMode] = useState<ViewMode>('agent')
  const [workingMode, setWorkingMode] = useState<ViewMode>('agent')

  const todos = {
    Icon: ListChecks,
    label: 'Todos',
    onClick: () => undefined,
  }
  const files = {
    Icon: PanelRight,
    label: 'Files',
    onClick: () => undefined,
  }
  const agents = {
    Icon: Users,
    label: 'Agents',
    onClick: () => undefined,
  }

  return (
    <section className="grid gap-5 rounded-[14px] border border-(--color-border) bg-(--bg-card) p-5 text-(--color-text)">
      <div>
        <h2 className="font-hand text-3xl font-bold">AgentTopbar</h2>
        <p className="text-sm text-(--color-text-2)">
          Composite topbar right-cluster used across single-agent and team chats.
        </p>
      </div>

      <div className="grid gap-3">
        <PreviewFrame
          title="1 · Default"
          description="Idle agent view — no token meter."
        >
          <AgentTopbar
            viewMode={defaultMode}
            onViewModeChange={setDefaultMode}
            todosAction={todos}
            filesAction={files}
            agentsAction={agents}
          />
        </PreviewFrame>

        <PreviewFrame
          title="2 · Working"
          description="Token meter pulses while output climbs."
        >
          <AgentTopbar
            tokens={{ input: 12_400, output: 3_200, cached: 8_100, pulsing: true }}
            viewMode={workingMode}
            onViewModeChange={setWorkingMode}
            todosAction={{ ...todos, indicator: true }}
            filesAction={files}
            agentsAction={agents}
          />
        </PreviewFrame>
      </div>
    </section>
  )
}
