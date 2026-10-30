/**
 * /settings/plugins — what the plugin runtime loaded (v3 only).
 *
 * Read-only: plugins are files in the plugin folder, loaded once per backend
 * process. The page surfaces what otherwise only reaches the backend log —
 * load errors, and v2 Python plugins that v3 does not run.
 */
import { useEffect } from 'react'
import { Puzzle, RefreshCw } from 'lucide-react'

import type { PluginStatus, PluginsResponse } from '@/api/client'
import { CAPABILITY, useServerCapability } from '@/queries'
import { usePluginsQuery } from '@/queries/usePluginsQuery'
import { useToastStore } from '@/stores/useToastStore'
import { Button } from '@/components/ui/button'
import { EmptyState } from '@/components/ui/empty-state'
import { SectionCard } from '@/components/ui/section-card'
import { Callout } from '@/components/ui/callout'
import { Chip } from '@/components/ui/chip'
import { Skeleton } from '@/components/ui/skeleton'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { SettingsPage } from '@/components/settings/SettingsPage'
import { ICON_SIZE_INLINE, TEXT } from '@/components/settings/tokens'
import { cn } from '@/lib/utils'

const CODE = 'rounded-xs border border-(--color-border) bg-(--bg-key) px-1 py-0.5 font-mono text-[11px] text-(--color-text) break-all [box-decoration-break:clone]'

/** Hook names as words; the raw name stays in the title for matching docs. */
const HOOK_LABEL: Record<string, string> = {
  'tool.before': 'before tool call',
  'tool.after': 'after tool call',
}

function PluginRow({ plugin }: { plugin: PluginStatus }) {
  const failed = plugin.status === 'error'
  return (
    <li className="flex flex-col gap-1.5 px-4 py-3.5">
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <span className="min-w-0 truncate font-mono text-xs font-semibold text-(--color-text)">{plugin.file}</span>
        <Chip tone={failed ? 'error' : 'success'}>{failed ? 'Failed to load' : 'Loaded'}</Chip>
      </div>
      {(plugin.provider || plugin.hooks.length > 0) && (
        <p className={cn('flex flex-wrap gap-x-3 gap-y-0.5', TEXT.hint)}>
          {plugin.provider && (
            <span>Provider: <span className="font-mono text-(--color-text)">{plugin.provider}</span></span>
          )}
          {plugin.hooks.length > 0 && (
            <span>
              Hooks:{' '}
              {plugin.hooks.map((h, i) => (
                <span key={h} title={h}>{i > 0 ? ', ' : ''}{HOOK_LABEL[h] ?? h}</span>
              ))}
            </span>
          )}
        </p>
      )}
      {plugin.errors.length > 0 && (
        <ul className="space-y-1">
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
    <SettingsPage
      title="Plugins"
      description={
        <>
          TypeScript and JavaScript plugins from{' '}
          {dir ? <code className={CODE}>{dir}</code> : 'the plugin folder'}. Restart OpenAgentd to load new or
          changed plugins.
        </>
      }
      actions={
        <Tooltip>
          <TooltipTrigger
            render={
              <Button variant="default" size="sm" onClick={() => void refetch()} disabled={isFetching}>
                <RefreshCw size={ICON_SIZE_INLINE} className={cn('shrink-0', isFetching && 'animate-spin')} aria-hidden="true" />
                Refresh
              </Button>
            }
          />
          <TooltipContent>Reload the list. Plugins themselves load only when OpenAgentd starts.</TooltipContent>
        </Tooltip>
      }
    >
      {unported.length > 0 && (
        <Callout
          tone="warning"
          role="alert"
          title={`${unported.length === 1 ? '1 Python plugin is' : `${unported.length} Python plugins are`} not running`}
          action={
            <ul className="flex flex-wrap gap-1.5">
              {unported.map((u) => <li key={u.path}><code className={CODE} title={u.path}>{u.file}</code></li>)}
            </ul>
          }
        >
          Only <code className={CODE}>.ts</code>/<code className={CODE}>.js</code> plugins run here. Add a
          TypeScript port with the same name next to each file.
        </Callout>
      )}

      {isError ? (
        <Callout
          tone="error"
          role="alert"
          title="Couldn't load plugins"
          action={<Button size="xs" onClick={() => void refetch()}>Retry</Button>}
        >
          {error instanceof Error ? error.message : String(error)}
        </Callout>
      ) : isLoading ? (
        <SectionCard role="status" aria-label="Loading plugins">
          <div className="divide-y divide-(--color-border-subtle)">
            {[0, 1].map((i) => (
              <div key={i} className="space-y-1.5 px-4 py-3.5">
                <Skeleton className="h-3.5 w-40" />
                <Skeleton className="h-3 w-56" />
              </div>
            ))}
          </div>
        </SectionCard>
      ) : plugins.length === 0 ? (
        <SectionCard className="border-dashed">
          <EmptyState
            fill={false}
            className="px-6 py-10"
            icon={Puzzle}
            title="No plugins installed"
            body="Put a .ts or .js plugin in the plugin folder, then restart OpenAgentd."
          />
        </SectionCard>
      ) : (
        <section aria-label="Installed plugins" className="space-y-3">
          <h2 className={cn('select-none', TEXT.title)}>
            {`Installed · ${plugins.length}${failed ? ` · ${failed} failed` : ''}`}
          </h2>
          <SectionCard>
            <ul className="divide-y divide-(--color-border-subtle)">
              {plugins.map((p) => <PluginRow key={p.path} plugin={p} />)}
            </ul>
          </SectionCard>
        </section>
      )}
    </SettingsPage>
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
