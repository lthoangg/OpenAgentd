/**
 * /settings/plugins — what the plugin runtime loaded (v3 only).
 *
 * Read-only: plugins are files in the plugin folder, loaded once per backend
 * process. The page surfaces what otherwise only reaches the backend log —
 * load errors, and v2 Python plugins that v3 does not run.
 */
import { useEffect } from 'react'
import { AlertCircle, AlertTriangle, CheckCircle2, Puzzle, RefreshCw } from 'lucide-react'

import type { PluginStatus, PluginsResponse } from '@/api/client'
import { CAPABILITY, useServerCapability } from '@/queries'
import { usePluginsQuery } from '@/queries/usePluginsQuery'
import { useToastStore } from '@/stores/useToastStore'
import { Button } from '@/components/ui/button'
import { ICON_SIZE, ICON_SIZE_INLINE, TEXT } from '@/components/settings/tokens'
import { cn } from '@/lib/utils'

const CODE = 'rounded-xs border border-(--color-border) bg-(--bg-key) px-1 py-0.5 font-mono text-[11px] text-(--color-text)'

function Badge({ children }: { children: string }) {
  return (
    <span className="shrink-0 rounded-xs border border-(--color-border) bg-(--bg-key)/50 px-1.5 py-0.5 font-mono text-xs md:text-[11px] text-(--color-text-muted)">
      {children}
    </span>
  )
}

function PluginRow({ plugin }: { plugin: PluginStatus }) {
  const failed = plugin.status === 'error'
  return (
    <li className="flex flex-col gap-1.5 px-3 py-2.5 sm:px-4">
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        {failed ? (
          <AlertCircle size={ICON_SIZE_INLINE} className="shrink-0 text-(--color-error)" aria-label="Failed to load" />
        ) : (
          <CheckCircle2 size={ICON_SIZE_INLINE} className="shrink-0 text-(--color-success)" aria-label="Loaded" />
        )}
        <span className="min-w-0 truncate font-mono text-xs font-semibold text-(--color-text)">{plugin.file}</span>
        {plugin.provider && <Badge>{`provider: ${plugin.provider}`}</Badge>}
        {plugin.hooks.map((h) => <Badge key={h}>{h}</Badge>)}
      </div>
      {plugin.errors.length > 0 && (
        <ul className="space-y-1 pl-5">
          {plugin.errors.map((e) => (
            <li key={e} className="break-words font-mono text-[11px] leading-relaxed text-(--color-error)">{e}</li>
          ))}
        </ul>
      )}
    </li>
  )
}

export function PluginsSettingsPage() {
  const { data, isLoading, isError, error, refetch, isFetching } = usePluginsQuery()
  const plugins = data?.plugins ?? []
  const unported = data?.unported ?? []
  const failed = plugins.filter((p) => p.status === 'error').length
  const dir = data?.dirs[0]

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden bg-(--bg-page) text-(--color-text)">
      <header className="sticky top-0 z-10 flex h-11 shrink-0 items-center gap-2 border-b border-(--color-border) bg-(--bg-page) px-3 sm:px-4 select-none">
        <Puzzle size={ICON_SIZE} className="shrink-0 text-(--color-text-muted)" aria-hidden="true" />
        <h1 className={cn('truncate', TEXT.title)}>Plugins</h1>
        <div className="min-w-1 flex-1" />
        <Button variant="subtle" size="sm" onClick={() => void refetch()} disabled={isFetching} className="flex items-center gap-1.5 text-xs">
          <RefreshCw size={ICON_SIZE_INLINE} className={cn('shrink-0', isFetching && 'animate-spin')} aria-hidden="true" />
          <span>Refresh</span>
        </Button>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="border-b border-(--color-border) px-3 py-2.5 sm:px-4">
          <p className={TEXT.body}>
            TypeScript and JavaScript plugins from{' '}
            {dir ? <code className={CODE}>{dir}</code> : 'the plugin folder'}. They load when the backend starts, so
            restart it after adding or editing a plugin. <code className={CODE}>openagentd.d.ts</code> in that folder
            types the plugin API.
          </p>
        </div>

        {unported.length > 0 && (
          <div role="alert" className="mx-3 my-2.5 rounded-sm border border-(--color-warning)/30 bg-(--color-warning-subtle) p-3 text-xs text-(--color-accent-orange-text) sm:mx-4">
            <div className="flex items-center gap-2 font-medium">
              <AlertTriangle size={14} className="shrink-0" aria-hidden="true" />
              <span>
                {unported.length === 1 ? '1 Python plugin is' : `${unported.length} Python plugins are`} not running
              </span>
            </div>
            <p className="mt-1.5 leading-relaxed">
              This backend runs only <code className={CODE}>.ts</code>/<code className={CODE}>.js</code> plugins.
              Port each file to TypeScript under the same name next to it; the Python version keeps working with the
              Python backend.
            </p>
            <ul className="mt-2 flex flex-wrap gap-1.5">
              {unported.map((u) => <li key={u.path}><code className={CODE} title={u.path}>{u.file}</code></li>)}
            </ul>
          </div>
        )}

        {isError ? (
          <p className="p-4 text-center text-xs text-(--color-error)">
            Could not load plugin status: {error instanceof Error ? error.message : String(error)}
          </p>
        ) : isLoading ? (
          <p className="p-4 text-center font-mono text-xs text-(--color-text-muted)">Loading plugins…</p>
        ) : plugins.length === 0 ? (
          <p className="p-6 text-center text-xs text-(--color-text-muted)">No plugins installed.</p>
        ) : (
          <section aria-label="Installed plugins">
            <p className="px-3 pt-3 pb-1 label-caps text-(--color-text-subtle) sm:px-4">
              {`Installed (${plugins.length})${failed ? ` · ${failed} failed` : ''}`}
            </p>
            <ul className="divide-y divide-(--color-border)">
              {plugins.map((p) => <PluginRow key={p.path} plugin={p} />)}
            </ul>
          </section>
        )}
      </div>
    </div>
  )
}

// ── Startup notice ──────────────────────────────────────────────────────────

/*
 * One-time heads-up when the backend is not running some plugins: v2 Python
 * plugins without a TypeScript port (v3 ignores `*.py`), or plugins that failed
 * to load. Without it the only trace is a backend log line. Shown once per
 * distinct set of affected files per browser session; v2 backends never show it
 * (no `api.plugins` capability).
 */

const SEEN_PREFIX = 'oad.pluginNotice:'

export function pluginNoticeText(data: PluginsResponse): { key: string; description: string } | null {
  const unported = data.unported.map((u) => u.file)
  const failed = data.plugins.filter((p) => p.status === 'error').map((p) => p.file)
  if (unported.length === 0 && failed.length === 0) return null
  const parts: string[] = []
  if (unported.length) parts.push(`${unported.length} Python plugin${unported.length === 1 ? ' needs' : 's need'} a TypeScript port`)
  if (failed.length) parts.push(`${failed.length} failed to load`)
  return {
    key: SEEN_PREFIX + [...unported, '|', ...failed].sort().join(','),
    description: `${parts.join('; ')}. See Settings → Plugins.`,
  }
}

export function PluginNotice(): null {
  const supported = useServerCapability(CAPABILITY.plugins)
  const { data } = usePluginsQuery(supported)
  const push = useToastStore((s) => s.push)

  useEffect(() => {
    if (!supported || !data) return
    const notice = pluginNoticeText(data)
    if (!notice) return
    try {
      if (sessionStorage.getItem(notice.key)) return
      sessionStorage.setItem(notice.key, '1')
    } catch {
      // Storage unavailable (private mode): still show it, just not deduplicated.
    }
    push({ tone: 'info', title: 'Some plugins are not running', description: notice.description }, 12_000)
  }, [supported, data, push])

  return null
}
