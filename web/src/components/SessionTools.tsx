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
import { ChevronDown, Plug, Wrench } from 'lucide-react'

import type { AgentInfo } from '@/api/types'
import { SearchBar } from '@/components/ui/search-bar'
import { useReducedMotion } from '@/hooks/useReducedMotion'
// LazyMarkdownBlock (not MarkdownBlock) — a static import of `@/utils/markdown`
// here would force the whole markdown chunk (renderer + Mermaid) to load and
// parse at startup, defeating the app-wide lazy-markdown split (rolldown warns
// with INEFFECTIVE_DYNAMIC_IMPORT). Tool descriptions render on expand, so the
// plain-text Suspense fallback is fine.
import { LazyMarkdownBlock } from '@/utils/LazyMarkdownBlock'

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
    <span className="rounded-xs border border-(--color-border) bg-(--bg-key) px-1.5 py-0.5 text-[10px] text-(--color-text-muted)">
      {count}
    </span>
  )
}

function ToolRow({ name, description }: { name: string; description: string }) {
  const [open, setOpen] = useState(false)
  const reduceMotion = useReducedMotion()
  const hasDesc = description.trim().length > 0
  return (
    <div className="overflow-hidden rounded-sm border border-(--color-border) bg-(--bg-card) transition-colors hover:bg-(--bg-key)/20">
      <button
        type="button"
        onClick={() => hasDesc && setOpen((v) => !v)}
        aria-expanded={hasDesc ? open : undefined}
        className={`flex min-h-9 w-full items-center gap-2.5 px-3 py-1.5 text-left md:min-h-0 ${hasDesc ? 'cursor-pointer' : 'cursor-default'}`}
      >
        <Wrench size={12} className="shrink-0 text-(--color-text-muted)" aria-hidden />
        <code className="flex-1 truncate font-mono text-xs font-medium text-(--color-text)">
          {name}
        </code>
        {hasDesc && (
          <ChevronDown
            size={12}
            aria-hidden
            className={`shrink-0 text-(--color-text-muted) transition-transform duration-150 ${open ? 'rotate-180' : ''}`}
          />
        )}
      </button>
      <AnimatePresence initial={false}>
        {open && hasDesc && (
          <motion.div
            initial={reduceMotion ? false : { height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={reduceMotion ? { opacity: 0 } : { height: 0, opacity: 0 }}
            transition={{ duration: reduceMotion ? 0 : 0.14 }}
            className="overflow-hidden"
          >
            <div className="tool-desc border-t border-(--color-border) px-3 py-2">
              <LazyMarkdownBlock content={description.trim()} />
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}

function ToolGroupSection({ server, tools }: ToolGroup) {
  const label = server === null ? 'Built-in' : `MCP · ${server}`
  return (
    <div role="group" aria-label={label}>
      <div className="flex items-center gap-2 px-3 pt-3 pb-1.5 sm:px-5">
        {server !== null && (
          <Plug size={11} className="text-(--color-text-muted)" aria-hidden />
        )}
        <h4 className="text-[10px] font-semibold uppercase tracking-widest text-(--color-text-muted)">
          {label}
        </h4>
        <CountBadge count={tools.length} />
      </div>
      <div className="space-y-1.5 px-3 sm:px-5">
        {tools.length === 0 ? (
          <p className="text-xs italic text-(--color-text-muted)">
            Server not ready — no tools available.
          </p>
        ) : (
          tools.map((t) => <ToolRow key={t.name} name={t.name} description={t.description} />)
        )}
      </div>
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
    <section className="border-t border-(--color-border)">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex min-h-11 w-full items-center gap-2 px-3 py-2.5 text-left transition-colors hover:bg-(--bg-key)/20 sm:px-5"
      >
        <h3 className="text-[10px] font-semibold uppercase tracking-widest text-(--color-text-muted)">
          Tools
        </h3>
        <CountBadge count={tools.length} />
        <ChevronDown
          size={12}
          aria-hidden
          className={`ml-auto shrink-0 text-(--color-text-muted) transition-transform duration-150 ${open ? 'rotate-180' : ''}`}
        />
      </button>

      {open && (
        <>
          {showSearch && (
            <div className="px-3 pb-2 sm:px-5">
              <SearchBar
                placeholder="Filter tools…"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
            </div>
          )}

          <div className="pb-3 sm:pb-5">
            {filteredTools.length === 0 && query.trim() ? (
              <p className="px-3 pt-2 text-xs italic text-(--color-text-muted) sm:px-5">
                No tools match “{query}”.
              </p>
            ) : (
              groups.map((group) => (
                <ToolGroupSection
                  key={group.server ?? '__builtin__'}
                  server={group.server}
                  tools={group.tools}
                />
              ))
            )}
          </div>
        </>
      )}
    </section>
  )
}
