/**
 * /settings/plugins — what the plugin runtime loaded (v3 only).
 *
 * Two lists. Bundles (folders with a manifest) are managed here: each has a
 * switch and details that say what it adds, what will run on this machine and
 * what its code may do, and Reload rescans the plugin folders. Single-file
 * plugins stay read-only: they are files in the plugin folder, loaded once per
 * backend process, so the page surfaces what otherwise only reaches the
 * backend log — load errors, and v2 Python plugins that v3 does not run.
 */
import { Fragment, useEffect, useId, useState, type ReactNode } from 'react'
import { ChevronRight, RefreshCw } from 'lucide-react'

import type {
  PluginBundle,
  PluginBundleMcpServer,
  PluginBundleState,
  PluginStatus,
  PluginsResponse,
} from '@/api/client'
import { CAPABILITY, useServerCapability } from '@/queries'
import {
  usePluginsQuery,
  useReloadPluginsMutation,
  useSetPluginBundleEnabledMutation,
} from '@/queries/usePluginsQuery'
import { useToastStore } from '@/stores/useToastStore'
import { Button } from '@/components/ui/button'
import { PanelSection } from '@/components/ui/panel-section'
import { SectionCard } from '@/components/ui/section-card'
import { Callout } from '@/components/ui/callout'
import { Chip, type ChipTone } from '@/components/ui/chip'
import { Skeleton } from '@/components/ui/skeleton'
import { Switch } from '@/components/ui/switch'
import { TERMS } from '@/components/ui/term'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { SettingsPage } from '@/components/settings/SettingsPage'
import { ICON_SIZE_INLINE, TEXT } from '@/components/settings/tokens'
import { commandLine } from '@/utils/command-line'
import { errorMessage } from '@/utils/errors'
import { cn } from '@/lib/utils'

const CODE = 'rounded-xs border border-(--color-border) bg-(--bg-key) px-1 py-0.5 font-mono text-meta text-(--color-text) [overflow-wrap:anywhere] [box-decoration-break:clone]'
/** Inside a card the code sits on a fill: nothing in a framed container draws a second frame. */
const CODE_IN_CARD = 'rounded-xs bg-(--bg-key) px-1 py-0.5 font-mono text-meta text-(--color-text) [overflow-wrap:anywhere] [box-decoration-break:clone]'
/** An identifier in a detail: a name, a path, a host. */
const MONO = 'font-mono text-meta text-(--color-text) [overflow-wrap:anywhere]'

const ADD_BUNDLE_COMMAND = 'agentd plugin add <git-url or folder>'

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`

/** A group's label, with its size once it has something in it ("Skills · 2"). */
const counted = (label: string, n: number) => (n > 0 ? `${label} · ${n}` : label)

/** A path that can wrap after a separator, so a long one breaks between folders and not inside a name. */
function PathText({ path }: { path: string }) {
  // Each folder with the separator that follows it (no lookbehind: older WebKit cannot parse it).
  const parts = path.match(/[^/\\]+[/\\]?|[/\\]/g) ?? [path]
  return parts.map((part, i) => (
    <Fragment key={i}>{i > 0 && <wbr />}{part}</Fragment>
  ))
}

/** Hook names as words; the raw name stays in the title for matching docs. */
const HOOK_LABEL: Record<string, string> = {
  'tool.before': 'before tool call',
  'tool.after': 'after tool call',
}

// ── Single-file plugins ─────────────────────────────────────────────────────

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
            <li key={e} className="break-words font-mono text-meta leading-relaxed text-(--color-error)">{e}</li>
          ))}
        </ul>
      )}
    </li>
  )
}

// ── Bundles ─────────────────────────────────────────────────────────────────

/** A state as a word and a tone, so colour is never the only signal. */
const BUNDLE_STATE: Record<PluginBundleState, { label: string; tone: ChipTone }> = {
  running: { label: 'Running', tone: 'success' },
  pending: { label: 'Pending', tone: 'info' },
  stopped: { label: 'Stopped', tone: 'neutral' },
  blocked: { label: 'Blocked', tone: 'warning' },
  failed: { label: 'Failed', tone: 'error' },
  // Same word as an MCP server that is switched off.
  disabled: { label: 'Off', tone: 'neutral' },
}

/** What a bundle adds, in words ("2 skills · 1 MCP server · 1 tool"). */
function bundleContents(bundle: PluginBundle): string {
  return [
    bundle.skills.length > 0 ? plural(bundle.skills.length, 'skill') : null,
    bundle.mcp_servers.length > 0 ? plural(bundle.mcp_servers.length, 'MCP server') : null,
    bundle.tools.length > 0 ? plural(bundle.tools.length, 'tool') : null,
  ].filter(Boolean).join(' · ')
}

function Detail({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid gap-1 sm:grid-cols-[6.5rem_minmax(0,1fr)] sm:gap-3">
      <dt className={cn('select-none', TEXT.hint)}>{label}</dt>
      <dd className="min-w-0 text-xs leading-relaxed text-(--color-text)">{children}</dd>
    </div>
  )
}

function None({ children = 'None' }: { children?: ReactNode }) {
  return <span className="text-(--color-text-muted)">{children}</span>
}

/** A name, with its description under it. */
function NameAndText({ name, text, marker }: { name: string; text?: string; marker?: ReactNode }) {
  return (
    <>
      <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <span className={MONO}>{name}</span>
        {marker}
      </span>
      {text && <span className={cn('block', TEXT.hint)}>{text}</span>}
    </>
  )
}

function McpServerDetail({ server }: { server: PluginBundleMcpServer }) {
  const stdio = server.transport === 'stdio'
  // What will run on this machine, or where it will connect to, as it will be run.
  const target = stdio ? (server.command ? commandLine(server.command, server.args) : null) : server.url
  return (
    <>
      <NameAndText
        name={server.name}
        marker={<Chip mono title={stdio ? TERMS.stdio : TERMS.http}>{server.transport}</Chip>}
      />
      <span className={cn('block', TEXT.hint)}>
        {target ? (
          <>
            {stdio ? 'Runs' : 'Connects to'} <code className={CODE_IN_CARD}>{target}</code>
          </>
        ) : (
          stdio ? 'No command given' : 'No URL given'
        )}
      </span>
    </>
  )
}

/** What a bundle's code may do, one line per kind of access it was given. */
function Permissions({ bundle }: { bundle: PluginBundle }) {
  const p = bundle.permissions
  if (!p) {
    return <None>{bundle.has_code ? 'None requested' : 'None. It has no plugin code.'}</None>
  }
  const list = (values: readonly string[], paths = false) => (
    values.map((v) => <code key={v} className={CODE_IN_CARD}>{paths ? <PathText path={v} /> : v}</code>)
  )
  const lines: { label: string; body: ReactNode }[] = []
  if (p.net === true) lines.push({ label: 'Network', body: <Chip tone="warning">any host</Chip> })
  else if (Array.isArray(p.net) && p.net.length > 0) lines.push({ label: 'Network', body: list(p.net) })
  if (p.listen) lines.push({ label: 'Listen', body: <span>can open a local port</span> })
  if (p.fs.length > 0) lines.push({ label: 'Folders', body: list(p.fs, true) })
  if (p.subprocess.length > 0) lines.push({ label: 'Commands', body: list(p.subprocess) })
  if (p.env.length > 0) lines.push({ label: 'Environment', body: list(p.env) })
  if (lines.length === 0) return <None>None requested</None>
  return (
    <ul className="space-y-1.5">
      {lines.map((line) => (
        <li key={line.label} className="grid grid-cols-[5.5rem_minmax(0,1fr)] items-baseline gap-x-2">
          <span className={TEXT.hint}>{line.label}</span>
          <span className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-1">{line.body}</span>
        </li>
      ))}
    </ul>
  )
}

function BundleDetails({ bundle, id }: { bundle: PluginBundle; id: string }) {
  return (
    <div id={id} className="border-t border-(--color-border-subtle) py-4 pr-4 pl-4 sm:pl-10">
      <dl className="space-y-4">
        <Detail label="Path">
          <span className={MONO}><PathText path={bundle.path} /></span>
        </Detail>
        <Detail label={counted('Skills', bundle.skills.length)}>
          {bundle.skills.length === 0 ? <None /> : (
            <ul className="space-y-2">
              {bundle.skills.map((skill) => (
                <li key={skill.name}><NameAndText name={skill.name} text={skill.description} /></li>
              ))}
            </ul>
          )}
        </Detail>
        <Detail label={counted('MCP servers', bundle.mcp_servers.length)}>
          {bundle.mcp_servers.length === 0 ? <None /> : (
            <ul className="space-y-3">
              {bundle.mcp_servers.map((server) => (
                <li key={server.name} className="space-y-1"><McpServerDetail server={server} /></li>
              ))}
            </ul>
          )}
        </Detail>
        <Detail label={counted('Tools', bundle.tools.length)}>
          {bundle.tools.length === 0 ? <None /> : (
            <ul className="space-y-2">
              {bundle.tools.map((tool) => (
                <li key={tool.name}>
                  <NameAndText
                    name={tool.name}
                    text={tool.description}
                    marker={tool.read_only ? <Chip title="This tool only reads; it changes nothing.">read-only</Chip> : null}
                  />
                </li>
              ))}
            </ul>
          )}
        </Detail>
        <Detail label="Permissions"><Permissions bundle={bundle} /></Detail>
        {bundle.warnings.length > 0 && (
          <Detail label={counted('Warnings', bundle.warnings.length)}>
            <ul className="space-y-1">
              {bundle.warnings.map((w, i) => (
                <li key={`${i}:${w}`} className="break-words text-(--accent-orange-text)">{w}</li>
              ))}
            </ul>
          </Detail>
        )}
      </dl>
    </div>
  )
}

/**
 * One bundle: its name, version and description, its state and a switch, and
 * (opened) the details. The switch sits beside the disclosure button, not in
 * it. A grid puts the state under the text on phones and beside it from `sm`.
 * Errors stay in view when the row is closed: a bundle that failed needs them.
 */
function BundleRow({
  bundle,
  busy,
  locked,
  onToggle,
}: {
  bundle: PluginBundle
  /** Its own switch change is in flight. */
  busy: boolean
  /** No switch can be changed now (a reload is running). */
  locked: boolean
  onToggle: (bundle: PluginBundle, enabled: boolean) => void
}) {
  const [expanded, setExpanded] = useState(false)
  const detailsId = useId()
  const status = BUNDLE_STATE[bundle.state] ?? { label: bundle.state, tone: 'neutral' as const }
  const contents = bundleContents(bundle)

  return (
    <li aria-label={bundle.name} aria-busy={busy || undefined}>
      <div className="grid grid-cols-[minmax(0,1fr)_auto_auto] items-center transition-colors duration-(--motion-instant) hover:bg-(--bg-key)/40 max-sm:grid-cols-[minmax(0,1fr)_auto] max-sm:items-start">
        <button
          type="button"
          aria-expanded={expanded}
          aria-controls={expanded ? detailsId : undefined}
          onClick={() => setExpanded((open) => !open)}
          className="col-start-1 row-start-1 flex min-h-14 min-w-0 items-start gap-2 py-3 pr-3 pl-4 text-left focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-(--focus-ring) max-sm:min-h-0 max-sm:pb-1.5"
        >
          <ChevronRight
            size={14}
            aria-hidden="true"
            className={cn('mt-0.5 shrink-0 text-(--color-text-muted) transition-transform duration-(--motion-fast)', expanded && 'rotate-90')}
          />
          <span className="min-w-0 flex-1">
            <span className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-0.5">
              <span className={cn('min-w-0 font-mono [overflow-wrap:anywhere]', TEXT.label)}>{bundle.name}</span>
              {bundle.version && <span className={cn('font-mono', TEXT.hint)}>{bundle.version}</span>}
            </span>
            {bundle.description && (
              <span className={cn('mt-0.5 block', TEXT.hint, !expanded && 'line-clamp-2')}>{bundle.description}</span>
            )}
            {contents && <span className={cn('mt-0.5 block', TEXT.hint)}>{contents}</span>}
          </span>
        </button>

        <div className="col-start-2 row-start-1 flex flex-wrap items-center gap-1.5 pr-3 max-sm:col-start-1 max-sm:row-start-2 max-sm:pr-4 max-sm:pb-3 max-sm:pl-10">
          <Chip tone={status.tone} title={`state: ${bundle.state}`}>{status.label}</Chip>
          {bundle.warnings.length > 0 && <Chip tone="warning">{plural(bundle.warnings.length, 'warning')}</Chip>}
        </div>

        <div className="col-start-3 row-start-1 flex items-center pr-4 max-sm:col-start-2 max-sm:items-start max-sm:pt-2.5">
          <Switch
            checked={bundle.enabled}
            disabled={busy || locked}
            onCheckedChange={(enabled) => onToggle(bundle, enabled)}
            aria-label={`Enable ${bundle.name}`}
          />
        </div>
      </div>

      {bundle.errors.length > 0 && (
        <ul className="space-y-1 pr-4 pb-3 pl-4 sm:pl-10">
          {bundle.errors.map((e, i) => (
            <li key={`${i}:${e}`} className="break-words font-mono text-meta leading-relaxed text-(--color-error)">{e}</li>
          ))}
        </ul>
      )}

      {expanded && <BundleDetails bundle={bundle} id={detailsId} />}
    </li>
  )
}

/** "3 plugins · 1 failed": the section's size in words, with what needs a look. */
function countLine(total: number, one: string, failed: number): string {
  return [plural(total, one), failed > 0 ? `${failed} failed` : null].filter(Boolean).join(' · ')
}

export function PluginsSettingsPage() {
  const { data, isLoading, isError, error, refetch } = usePluginsQuery(true, { pollWhilePending: true })
  const reload = useReloadPluginsMutation()
  const setEnabled = useSetPluginBundleEnabledMutation()
  const push = useToastStore((s) => s.push)
  // Bundles whose switch change is in flight, so only those switches wait.
  const [toggling, setToggling] = useState<ReadonlySet<string>>(() => new Set())

  const bundles = data?.bundles ?? []
  const plugins = data?.plugins ?? []
  const unported = data?.unported ?? []
  const failedBundles = bundles.filter((b) => b.state === 'failed').length
  const failedPlugins = plugins.filter((p) => p.status === 'error').length
  const dir = data?.dirs[0]

  const handleReload = async () => {
    try {
      await reload.mutateAsync()
      push({ tone: 'success', title: 'Plugins reloaded' })
    } catch (err) {
      push({ tone: 'error', title: "Couldn't reload plugins", description: errorMessage(err) })
    }
  }

  const handleToggle = async (bundle: PluginBundle, enabled: boolean) => {
    setToggling((names) => new Set(names).add(bundle.name))
    try {
      await setEnabled.mutateAsync({ name: bundle.name, enabled })
    } catch (err) {
      push({
        tone: 'error',
        title: `Couldn't turn ${bundle.name} ${enabled ? 'on' : 'off'}`,
        description: errorMessage(err),
      })
    } finally {
      setToggling((names) => {
        const next = new Set(names)
        next.delete(bundle.name)
        return next
      })
    }
  }

  return (
    <SettingsPage
      title="Plugins"
      description="Bundles add skills, MCP servers and tools to OpenAgentd."
      actions={
        <Tooltip>
          <TooltipTrigger
            render={
              <Button variant="default" size="sm" onClick={() => void handleReload()} disabled={reload.isPending}>
                <RefreshCw size={ICON_SIZE_INLINE} className={cn('shrink-0', reload.isPending && 'animate-spin')} aria-hidden="true" />
                {reload.isPending ? 'Reloading…' : 'Reload'}
              </Button>
            }
          />
          <TooltipContent>Rescan the plugin folders and restart changed bundles. Single-file plugins load only when OpenAgentd starts.</TooltipContent>
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
      ) : (
        <>
          <PanelSection
            aria-label="Bundles"
            title="Bundles"
            actions={bundles.length > 0 ? <span className={cn('tabular-nums', TEXT.hint)}>{countLine(bundles.length, 'bundle', failedBundles)}</span> : undefined}
            flush={bundles.length > 0}
            className={bundles.length === 0 ? 'border-dashed' : undefined}
          >
            {bundles.length === 0 ? (
              <p className={cn('py-2 text-center', TEXT.body)}>
                No bundles yet. Add one with <code className={CODE_IN_CARD}>{ADD_BUNDLE_COMMAND}</code>.
              </p>
            ) : (
              <ul className="divide-y divide-(--color-border-subtle)">
                {bundles.map((b) => (
                  <BundleRow
                    key={b.name}
                    bundle={b}
                    busy={toggling.has(b.name)}
                    locked={reload.isPending}
                    onToggle={(bundle, enabled) => void handleToggle(bundle, enabled)}
                  />
                ))}
              </ul>
            )}
          </PanelSection>

          <PanelSection
            aria-label="Single-file plugins"
            title="Single-file plugins"
            description={
              <>
                TypeScript and JavaScript plugins from{' '}
                {dir ? <code className={CODE}><PathText path={dir} /></code> : 'the plugin folder'}. Restart OpenAgentd to load new or
                changed plugins.
              </>
            }
            actions={plugins.length > 0 ? <span className={cn('tabular-nums', TEXT.hint)}>{countLine(plugins.length, 'plugin', failedPlugins)}</span> : undefined}
            flush={plugins.length > 0}
            className={plugins.length === 0 ? 'border-dashed' : undefined}
          >
            {plugins.length === 0 ? (
              <p className={cn('py-2 text-center', TEXT.body)}>
                No single-file plugins. Put a .ts or .js file in the plugin folder.
              </p>
            ) : (
              <ul className="divide-y divide-(--color-border-subtle)">
                {plugins.map((p) => <PluginRow key={p.path} plugin={p} />)}
              </ul>
            )}
          </PanelSection>
        </>
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
