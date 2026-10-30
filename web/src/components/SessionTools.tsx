/**
 * SessionTools — what this session can actually do, grouped by origin.
 *
 * Open by default in session settings. The inventory is reference material you consult
 * occasionally, while the model picker and the MCP switches above it are used
 * every session. Users can toggle it closed if needed.
 *
 * Enable/disable for MCP servers deliberately lives in `SessionMcpServers`, not
 * here. This section only reads.
 */
import { useMemo, useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { DURATIONS_S } from '@/lib/motion'
import { ChevronDown } from 'lucide-react'

import type { AgentInfo } from '@/api/types'
import { TEXT } from '@/components/ui/panel-tokens'
import { SearchBar } from '@/components/ui/search-bar'
import { useReducedMotion } from '@/hooks/useReducedMotion'
import { cn } from '@/lib/utils'
import { MarkdownBlock } from '@/utils/markdown'

const TOOL_SEARCH_THRESHOLD = 8

interface ToolGroup {
  /** Group identifier — null for built-ins, server name otherwise. */
  server: string | null
  tools: AgentInfo['tools']
}

/** Group tools by origin. Membership is derived from the `<server>_<tool>`
 *  naming convention enforced by `MCPTool.__init__` on the backend, so it's the
 *  public contract. Servers listed in `mcp_servers` always appear, even with
 *  zero tools (configured but not ready); silently hiding them is worse than
 *  surfacing the state. */
function groupTools(tools: AgentInfo['tools'], mcpServers: string[]): ToolGroup[] {
  // Sort servers longest-prefix-first so a hypothetical `foo_bar_*` server
  // is matched before `foo_*` would steal its tools.
  const servers = [...mcpServers].sort((a, b) => b.length - a.length)
  const buckets = new Map<string, AgentInfo['tools']>(mcpServers.map((s) => [s, []]))
  const builtins: AgentInfo['tools'] = []

  for (const tool of tools) {
    const owner = servers.find((s) => tool.name.startsWith(`${s}_`))
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

function CountBadge({ count }: { count: number }) {
  return (
    <span className="text-[11px] font-normal tabular-nums text-(--color-text-subtle)">
      · {count}
    </span>
  )
}

/** The first sentence of a tool description, as plain text, for the row. */
function summaryLine(description: string): string {
  const text = description.trim().split(/\n\s*\n/)[0].replace(/[`*_#>]/g, '').replace(/\s+/g, ' ')
  const end = text.search(/[.!?](\s|$)/)
  return end > 0 ? text.slice(0, end + 1) : text
}

function ToolRow({ name, description }: { name: string; description: string }) {
  const [open, setOpen] = useState(false)
  const reduceMotion = useReducedMotion()
  const hasDesc = description.trim().length > 0
  return (
    <div className="overflow-hidden transition-colors hover:bg-(--bg-key)/20">
      <button
        type="button"
        onClick={() => hasDesc && setOpen((v) => !v)}
        aria-expanded={hasDesc ? open : undefined}
        className={`flex min-h-9 w-full items-center gap-3 px-4 py-2 text-left md:min-h-10 md:py-2.5 ${hasDesc ? 'cursor-pointer' : 'cursor-default'}`}
      >
        <code className="shrink-0 font-mono text-xs font-medium text-(--color-text)">
          {name}
        </code>
        <span className={cn('min-w-0 flex-1 truncate', TEXT.hint)}>
          {hasDesc && !open ? summaryLine(description) : ''}
        </span>
        {hasDesc && (
          <ChevronDown
            size={12}
            aria-hidden
            className={`shrink-0 text-(--color-text-muted) transition-transform duration-(--motion-fast) ${open ? 'rotate-180' : ''}`}
          />
        )}
      </button>
      <AnimatePresence initial={false}>
        {open && hasDesc && (
          <motion.div
            initial={reduceMotion ? false : { height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={reduceMotion ? { opacity: 0 } : { height: 0, opacity: 0 }}
            transition={{ duration: reduceMotion ? 0 : DURATIONS_S.fast }}
            className="overflow-hidden"
          >
            <div className="tool-desc px-4 pb-3 text-(--color-text-muted)">
              <MarkdownBlock content={description.trim()} />
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}

function ToolGroupSection({ server, tools }: ToolGroup) {
  const label = server === null ? 'Built-in tools' : `MCP server ${server}`
  return (
    <div role="group" aria-label={label}>
      <div className="flex items-center gap-1 border-b border-(--color-border-subtle) bg-(--bg-key)/20 px-4 py-2">
        <h3 className={cn('font-medium', TEXT.subtle)}>
          {server === null ? 'Built-in tools' : <>MCP server <span className="font-mono">{server}</span></>}
        </h3>
        <CountBadge count={tools.length} />
      </div>
      {tools.length === 0 ? (
        <p className={cn('px-4 py-3', TEXT.hint)}>
          The server is not ready, so it has no tools yet.
        </p>
      ) : (
        <div className="divide-y divide-(--color-border-subtle)">
          {tools.map((t) => <ToolRow key={t.name} name={t.name} description={t.description} />)}
        </div>
      )}
    </div>
  )
}

export function SessionTools({
  tools,
  mcpServers,
  defaultOpen = true,
}: {
  tools: AgentInfo['tools']
  mcpServers: string[]
  defaultOpen?: boolean
}) {
  const [open, setOpen] = useState(defaultOpen)
  const [query, setQuery] = useState('')
  const showSearch = tools.length > TOOL_SEARCH_THRESHOLD

  const filteredTools = useMemo(() => {
    if (!query.trim()) return tools
    const q = query.toLowerCase()
    return tools.filter(
      (t) => t.name.toLowerCase().includes(q) || t.description.toLowerCase().includes(q),
    )
  }, [tools, query])

  // Always pass the full mcpServers list so the user can see configured-but-empty
  // servers; once they type a query, hide empty groups so the filtered view
  // isn't padded out by sections that match nothing.
  const groups = useMemo(() => {
    const all = groupTools(filteredTools, mcpServers)
    if (!query.trim()) return all
    return all.filter((g) => g.tools.length > 0)
  }, [filteredTools, mcpServers, query])

  if (tools.length === 0 && mcpServers.length === 0) return null

  return (
    <section className="space-y-3">
      <h2>
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          className="-mx-1.5 flex min-h-9 w-[calc(100%+0.75rem)] items-center gap-2 rounded-sm px-1.5 text-left transition-colors hover:bg-(--bg-key)/40 md:min-h-7 pointer-coarse:min-h-9"
        >
          <span className={TEXT.title}>Tools</span>
          <CountBadge count={tools.length} />
          <ChevronDown
            size={12}
            aria-hidden
            className={`ml-auto shrink-0 text-(--color-text-muted) transition-transform duration-(--motion-fast) ${open ? 'rotate-180' : ''}`}
          />
        </button>
      </h2>

      {open && (
        <div className="overflow-hidden rounded-sm border border-(--color-border) bg-(--bg-card)">
          {showSearch && (
            <div className="border-b border-(--color-border-subtle) px-4 py-3">
              <SearchBar
                placeholder="Filter tools…"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
            </div>
          )}

          {filteredTools.length === 0 && query.trim() ? (
            <p className={cn('px-4 py-4', TEXT.hint)}>
              No tools match “{query}”.
            </p>
          ) : (
            <div className="divide-y divide-(--color-border-subtle)">
              {groups.map((group) => (
                <ToolGroupSection
                  key={group.server ?? '__builtin__'}
                  server={group.server}
                  tools={group.tools}
                />
              ))}
            </div>
          )}
        </div>
      )}
    </section>
  )
}
