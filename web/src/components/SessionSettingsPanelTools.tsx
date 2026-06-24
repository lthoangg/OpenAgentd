import { useMemo, useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { ChevronDown, Plug, Search, Wrench } from 'lucide-react'

import type { AgentInfo } from '@/api/types'
import type { ServerStatus } from '@/api/client'
import { Button } from '@/components/ui/button'

const TOOL_SEARCH_THRESHOLD = 8

interface ToolGroup {
  /** Group identifier — null for built-ins, server name otherwise. */
  server: string | null
  tools: AgentInfo['tools']
}

/** Group tools by origin. Membership is derived from the `mcp_<server>_<tool>`
 *  naming convention enforced by `MCPTool.__init__` on the backend — the same
 *  convention the permission system already relies on, so it's the public
 *  contract. Servers listed in `mcp_servers` always appear, even with zero
 *  tools (configured but not ready); silently hiding them is worse than
 *  surfacing the state. */
function groupTools(
  tools: AgentInfo['tools'],
  mcpServers: string[],
): ToolGroup[] {
  // Sort servers longest-prefix-first so a hypothetical `mcp_foo_bar_*` server
  // is matched before `mcp_foo_*` would steal its tools.
  const servers = [...mcpServers].sort((a, b) => b.length - a.length)
  const buckets = new Map<string, AgentInfo['tools']>(
    mcpServers.map((s) => [s, []]),
  )
  const builtins: AgentInfo['tools'] = []

  for (const tool of tools) {
    const owner = servers.find((s) => tool.name.startsWith(`mcp_${s}_`))
    if (owner) buckets.get(owner)!.push(tool)
    else builtins.push(tool)
  }

  const groups: ToolGroup[] = []
  if (builtins.length > 0) groups.push({ server: null, tools: builtins })
  for (const name of [...mcpServers].sort()) {
    groups.push({ server: name, tools: buckets.get(name) ?? [] })
  }
  return groups
}

function ToolRow({ name, description }: { name: string; description: string }) {
  const [open, setOpen] = useState(false)
  const hasDesc = description.trim().length > 0
  return (
    <div className="overflow-hidden rounded-lg border border-(--color-border) bg-(--bg-page) transition-colors hover:border-(--color-border-strong)">
      <button
        onClick={() => hasDesc && setOpen((v) => !v)}
        className={`flex w-full items-center gap-2.5 px-3 py-2 text-left ${hasDesc ? 'cursor-pointer' : 'cursor-default'}`}
      >
        <Wrench size={12} className="shrink-0 text-(--color-text-muted)" />
        <code className="flex-1 truncate font-mono text-xs font-medium text-(--color-text)">{name}</code>
        {hasDesc && (
          <ChevronDown
            size={12}
            className={`shrink-0 text-(--color-text-muted) transition-transform duration-150 ${open ? 'rotate-180' : ''}`}
          />
        )}
      </button>
      <AnimatePresence initial={false}>
        {open && hasDesc && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.14 }}
            className="overflow-hidden"
          >
            <p className="border-t border-(--color-border) px-3 py-2 text-xs leading-relaxed text-(--color-text-muted)">
              {description}
            </p>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}

function ToolGroupHeader({
  server,
  count,
}: {
  server: string | null
  count: number
}) {
  if (server === null) {
    return (
      <div className="flex items-center gap-2 px-5 pt-3 pb-1.5">
        <h4 className="text-[10px] font-semibold uppercase tracking-widest text-(--color-text-muted)">
          Built-in
        </h4>
        <span className="rounded-md bg-(--bg-key) px-2 py-0.5 text-[10px] text-(--color-text-muted)">
          {count}
        </span>
      </div>
    )
  }
  return (
    <div className="flex items-center gap-2 px-5 pt-3 pb-1.5">
      <Plug size={11} className="text-(--color-text-muted)" aria-hidden />
      <h4 className="text-[10px] font-semibold uppercase tracking-widest text-(--color-text-muted)">
        MCP · {server}
      </h4>
      <span className="rounded-md bg-(--bg-key) px-2 py-0.5 text-[10px] text-(--color-text-muted)">
        {count}
      </span>
    </div>
  )
}

export function Tools({
  tools,
  mcpServers,
  serverStatuses,
  onToggleServer,
  onConnectOAuth,
  busyServer,
}: {
  tools: AgentInfo['tools']
  mcpServers: string[]
  serverStatuses: Map<string, ServerStatus>
  onToggleServer: (server: ServerStatus) => void
  onConnectOAuth: (server: ServerStatus) => void
  busyServer: string | null
}) {
  const [query, setQuery] = useState('')
  const showSearch = tools.length > TOOL_SEARCH_THRESHOLD

  const filteredTools = useMemo(() => {
    if (!query.trim()) return tools
    const q = query.toLowerCase()
    return tools.filter(
      (t) =>
        t.name.toLowerCase().includes(q) ||
        t.description.toLowerCase().includes(q),
    )
  }, [tools, query])

  // Always pass the full mcpServers list so the user can see configured-but-empty
  // servers; once they type a query, we hide empty groups so the filtered view
  // doesn't get padded out by sections that match nothing.
  const groups = useMemo(() => {
    const all = groupTools(filteredTools, mcpServers)
    if (!query.trim()) return all
    return all.filter((g) => g.tools.length > 0)
  }, [filteredTools, mcpServers, query])

  if (tools.length === 0 && mcpServers.length === 0) return null

  return (
    <section className="border-t border-(--color-border)">
      <div className="flex shrink-0 items-center gap-2 px-5 pt-4 pb-2">
        <h3 className="text-[10px] font-semibold uppercase tracking-widest text-(--color-text-muted)">
          Tools
        </h3>
        <span className="rounded-md bg-(--bg-key) px-2 py-0.5 text-[10px] text-(--color-text-muted)">
          {tools.length}
        </span>
      </div>

      {showSearch && (
        <div className="shrink-0 px-5 pb-2">
          <div className="flex items-center gap-2 rounded-lg border border-(--color-border) bg-(--bg-page) px-2.5 py-1.5 focus-within:border-(--color-border-strong)">
            <Search size={12} className="shrink-0 text-(--color-text-muted)" />
            <input
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Filter tools…"
              className="min-w-0 flex-1 bg-transparent text-xs text-(--color-text) placeholder:text-(--color-text-subtle) focus:outline-none"
              aria-label="Filter tools"
            />
          </div>
        </div>
      )}

      <div className="pb-5">
        {filteredTools.length === 0 && query.trim() ? (
          <p className="px-5 pt-2 text-xs italic text-(--color-text-muted)">
            No tools match “{query}”.
          </p>
        ) : (
          groups.map((group) => {
            const status = group.server ? serverStatuses.get(group.server) : undefined
            return (
              <div key={group.server ?? '__builtin__'}>
                <ToolGroupHeader server={group.server} count={group.tools.length} />
                {status && (
                  <div className="mb-2 flex flex-wrap items-center gap-2 px-5">
                    <span className="rounded-md bg-(--bg-key) px-2 py-0.5 text-[10px] font-medium text-(--color-text-muted)">
                      {status.enabled ? (status.state === 'auth_required' ? 'OAuth required' : status.state) : 'disabled'}
                    </span>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      disabled={!status.config || busyServer === status.name}
                      onClick={() => onToggleServer(status)}
                    >
                      {status.enabled ? 'Disable' : 'Enable'}
                    </Button>
                    {status.transport === 'http' && status.config?.transport === 'http' && status.config.oauth && (
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        disabled={!status.enabled || busyServer === status.name}
                        onClick={() => onConnectOAuth(status)}
                      >
                        Connect OAuth
                      </Button>
                    )}
                    {status.error && status.state !== 'auth_required' && (
                      <span className="text-[11px] text-(--color-error)">{status.error}</span>
                    )}
                  </div>
                )}
                <div className="space-y-1.5 px-5">
                  {group.tools.length === 0 ? (
                    <p className="text-xs italic text-(--color-text-muted)">
                      Server not ready — no tools available.
                    </p>
                  ) : (
                    group.tools.map((t) => (
                      <ToolRow key={t.name} name={t.name} description={t.description} />
                    ))
                  )}
                </div>
              </div>
            )
          })
        )}
      </div>
    </section>
  )
}
