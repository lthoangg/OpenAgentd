/**
 * The server's update, under the Server row of Settings → About → Version:
 * "Update to vX" when the server can install it (the CLI background server,
 * or a desktop app that updates itself), or what to do where it runs when
 * it cannot. The same button and note sit under the row of the server in
 * use (`ServerUpdateOnRow`: the Servers screen, the Server dialog).
 * Following the update through the restart is `useServerUpdateStore`'s job,
 * so it carries on if the user leaves Settings.
 *
 * `ownApp`: this window is the desktop app on its own built-in server. The
 * app's Updates section updates both, so there is no second button here.
 */
import { useState, type ReactNode } from 'react'
import { AlertTriangle, Check, Loader2 } from 'lucide-react'
import { QueryClientProvider, useQuery, useQueryClient } from '@tanstack/react-query'

import { health } from '@/api/client'
import type { ServerUpdateStatus } from '@/api/client/server-update'
import { Button } from '@/components/ui/button'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'
import { TEXT } from '@/components/settings/tokens'
import { sessionsSpending } from '@/lib/active-sessions'
import { openExternalUrl } from '@/lib/open-external'
import { queryClient as appQueryClient } from '@/lib/query-client'
import { cn } from '@/lib/utils'
import { queryKeys } from '@/queries'
import { SERVER_UPDATE_CAPABILITY, useServerUpdateQuery } from '@/queries/useServerUpdateQuery'
import { useServerUpdateStore } from '@/stores/useServerUpdateStore'

/** What to do instead when the server cannot be updated from here. */
export function blockedAdvice(status: Pick<ServerUpdateStatus, 'latest' | 'reason'>, ownApp = false): string {
  const out = status.latest ? `v${status.latest} is out. ` : ''
  if (ownApp) return `${out}This server comes with this app: update the app to update it.`
  switch (status.reason) {
    case 'desktop_sidecar':
      return `${out}This server is the desktop app on its computer: update the app there.`
    case 'foreground':
      return `${out}This server runs in the foreground, so update it where it runs: agentd upgrade, then start it again.`
    case 'unsupported_platform':
      return `${out}There is no prebuilt release for the server's platform; update it where it runs.`
    default:
      return `${out}Update it where it runs: agentd upgrade.`
  }
}

function Note({ tone, children }: { tone: 'hint' | 'warn' | 'ok'; children: ReactNode }) {
  return (
    <p
      role={tone === 'warn' ? 'alert' : 'status'}
      data-server-update-note={tone}
      className={cn(
        'flex items-start gap-2 px-4 pb-3 sm:px-5',
        TEXT.hint,
        tone === 'warn' && 'text-(--accent-orange-text)',
        tone === 'ok' && 'text-(--accent-green-text)',
      )}
    >
      {tone === 'warn' && <AlertTriangle size={14} className="mt-0.5 shrink-0" aria-hidden="true" />}
      {tone === 'ok' && <Check size={14} className="mt-0.5 shrink-0" aria-hidden="true" />}
      <span className="min-w-0">{children}</span>
    </p>
  )
}

/** The button that goes in the Server row, when there is one. */
export function ServerUpdateButton({ onRequest, ownApp = false }: { onRequest: () => void; ownApp?: boolean }) {
  const { data } = useServerUpdateQuery()
  const phase = useServerUpdateStore((s) => s.phase)
  if (ownApp) return null
  if (phase.kind === 'updating') {
    return (
      <Button size="sm" variant="default" disabled>
        <Loader2 size={14} className="animate-spin" aria-hidden="true" />
        Updating…
      </Button>
    )
  }
  if (!data?.available || !data.can_upgrade || !data.latest) return null
  if (phase.kind === 'failed') {
    return <Button size="sm" variant="default" onClick={onRequest}>Try again</Button>
  }
  return <Button size="sm" variant="primary" onClick={onRequest}>Update to v{data.latest}</Button>
}

/**
 * Start an update: at once, or after a confirm when agents are mid-turn
 * (read at click time from the active-sessions list the sidebar keeps live).
 */
export function useServerUpdateFlow() {
  const queryClient = useQueryClient()
  const start = useServerUpdateStore((s) => s.start)
  const [confirmOpen, setConfirmOpen] = useState(false)
  const run = () => {
    setConfirmOpen(false)
    void start({
      onSettled: () => {
        void queryClient.invalidateQueries({ queryKey: queryKeys.health() })
        void queryClient.invalidateQueries({ queryKey: queryKeys.serverUpdate() })
      },
    })
  }
  const request = () => {
    if (sessionsSpending(queryClient.getQueryData(queryKeys.session.sessions.active()))) setConfirmOpen(true)
    else run()
  }
  return { request, run, confirmOpen, setConfirmOpen }
}

/** The confirm shown when agents are working. */
export function ServerUpdateConfirm({ flow }: { flow: ReturnType<typeof useServerUpdateFlow> }) {
  return (
    <ConfirmDialog
      open={flow.confirmOpen}
      onOpenChange={flow.setConfirmOpen}
      tone="default"
      title="Restart the server while agents work?"
      description="Their turns stop for the restart and resume when the server is back."
      confirmLabel="Update and restart"
      onConfirm={flow.run}
    />
  )
}

/** The note under the Server row: what the update will do, or did. */
export function ServerUpdateNote({ ownApp = false }: { ownApp?: boolean }) {
  const { data } = useServerUpdateQuery()
  const phase = useServerUpdateStore((s) => s.phase)
  const byDesktopApp = data?.method === 'desktop_app'

  const releaseLink = data?.release_url ? (
    <>
      {' '}
      <button type="button" className="underline underline-offset-2 hover:text-(--color-text)" onClick={() => void openExternalUrl(data.release_url as string)}>
        What's new
      </button>
    </>
  ) : null

  if (ownApp) return data?.available ? <Note tone="hint">{blockedAdvice(data, true)}</Note> : null
  if (phase.kind === 'updating') {
    if (byDesktopApp) {
      return (
        <Note tone="hint">
          Updating to v{phase.target}: OpenAgentd on the computer downloads it and restarts, and this app reconnects on its own.
          {data?.confirm_on_computer ? ' If Windows asks, confirm the update on the computer.' : null}
        </Note>
      )
    }
    return <Note tone="hint">Updating to v{phase.target}: the server restarts, and the app reconnects on its own.</Note>
  }
  if (phase.kind === 'done') return <Note tone="ok">Updated v{phase.from} → v{phase.to}.</Note>
  if (phase.kind === 'failed') {
    return (
      <Note tone="warn">
        {phase.message}
        {phase.log ? <> Details: <span className="font-mono break-all">{phase.log}</span> on the server.</> : null}
      </Note>
    )
  }
  if (data?.available && data.can_upgrade && byDesktopApp) {
    return (
      <Note tone="hint">
        Updates OpenAgentd on that computer and restarts it. Running sessions resume. A few minutes.
        {data.confirm_on_computer ? ' Windows may ask to confirm it on the computer.' : null}
        {releaseLink}
      </Note>
    )
  }
  if (data?.available && data.can_upgrade) {
    return <Note tone="hint">Downloads the release, restarts the server, and resumes running sessions. About a minute.{releaseLink}</Note>
  }
  if (data?.available) return <Note tone="warn">{blockedAdvice(data)}</Note>
  return null
}

/**
 * Under the row of the server in use: the update button and its note, when
 * there is something to press or a run to follow. Nothing otherwise, so a
 * server that cannot be updated from here adds no line to its row (About
 * says what to do instead).
 *
 * The Servers screen and the Server dialog also show before the router and
 * its QueryClientProvider exist (App.tsx), so this brings the app's client
 * with it. And it only reads what the app already knows of the server: a
 * screen shown because no server answers must not start asking one.
 */
export function ServerUpdateOnRow() {
  return (
    <QueryClientProvider client={appQueryClient}>
      <OnRowOfKnownServer />
    </QueryClientProvider>
  )
}

function OnRowOfKnownServer() {
  const known = useQuery({ queryKey: queryKeys.health(), queryFn: health, enabled: false }).data
  if (!known?.capabilities?.includes(SERVER_UPDATE_CAPABILITY)) return null
  return <OnRow />
}

function OnRow() {
  const { data } = useServerUpdateQuery()
  const phase = useServerUpdateStore((s) => s.phase)
  const flow = useServerUpdateFlow()
  const offered = Boolean(data?.available && data.can_upgrade && data.latest)
  if (phase.kind === 'idle' && !offered) return null
  return (
    // Part of the row above it, which drops the list's hairline between them.
    <div data-server-update-on-row="">
      <div className="flex justify-end px-4 pb-2 empty:hidden sm:px-5">
        <ServerUpdateButton onRequest={flow.request} />
      </div>
      <ServerUpdateNote />
      <ServerUpdateConfirm flow={flow} />
    </div>
  )
}
