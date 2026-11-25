/**
 * WaitingForLine — at the live end of a session's transcript while it has
 * work coming back to it: subagents still running, sessions in other
 * workspaces that owe it a reply, and background commands it waits for. It
 * shows while the turn runs and stays after it closes, so the reader sees
 * what is still out: "Waiting for 3 sessions and 1 command", with a list
 * that opens each session and stops each command: a popover on desktop, a
 * sheet on a phone.
 *
 * Only sessions running or stopped on the person count (``activeWaiting``).
 * A subagent is a session you can open too, so both kinds count as
 * sessions, and the list says which is which. A command the session does
 * not wait for (a server) is listed so it can be stopped, but the line
 * never says it waits for one: with only servers left it reads "1 command
 * running". Nothing renders when nothing runs.
 */
import { useContext, useState } from 'react'
import { QueryClient, QueryClientContext, useQuery } from '@tanstack/react-query'
import { ChevronDown } from 'lucide-react'

import type { WaitingItem } from '@/api/types'
import { useElapsedClock } from '@/components/ToolCall/SubagentRow'
import { BottomSheet } from '@/components/ui/bottom-sheet'
import { Button } from '@/components/ui/button'
import { Chip } from '@/components/ui/chip'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { useIsPhone } from '@/hooks/use-is-phone'
import { STATUS, type StatusView } from '@/lib/status'
import { cn } from '@/lib/utils'
import { countWaiting, waitingText, type WaitingCounts } from '@/lib/waiting'
import { activeWaiting, sessionWaitingQuery, useStopCommand } from '@/queries/useSessionsQuery'
import { requestOpenSession } from '@/utils/workspace-messages'

/**
 * Stands in for the app's client where there is none (a transcript rendered
 * on its own), so the query below can be called unconditionally and stay off.
 */
const NO_CLIENT = new QueryClient()

const STATE: Record<WaitingItem['state'], StatusView> = {
  working: STATUS.running,
  needs_input: STATUS.needsYou,
  idle: STATUS.idle,
}

/** The same pill as the footer's files toggle: 24px, 36px on touch, 28px on a phone. */
const TRIGGER_CLASS = 'relative touch-hit inline-flex h-6 min-w-0 max-w-full items-center gap-1.5 rounded-xs px-1.5 text-xs text-(--color-text-2) transition-colors duration-(--motion-instant) hover:bg-(--bg-key) hover:text-(--color-text) aria-expanded:bg-(--bg-key) aria-expanded:text-(--color-text) focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-(--focus-ring) pointer-coarse:h-9 pointer-coarse:px-2.5 max-md:pointer-coarse:h-7 max-md:pointer-coarse:px-1.5'
const ROW_CLASS = 'flex min-h-9 w-full items-center gap-3 rounded-sm px-2 py-1 text-left max-md:pointer-coarse:min-h-(--phone-control)'

/**
 * `Waiting for 3 sessions and 1 command`, and `· 1 needs you` when a session
 * is stopped on the person. The dot is live only while something is coming
 * back; servers alone (`1 command running`) get a still one.
 */
function TriggerText({ text, counts }: { text: string; counts: WaitingCounts }) {
  const awaiting = counts.sessions + counts.commands > 0
  const needYou = counts.needYou
  return (
    <>
      <span aria-hidden="true" className={cn('size-1.5 shrink-0 rounded-full', awaiting ? 'bg-(--color-text) animate-pulse motion-reduce:animate-none' : 'bg-(--color-text-muted)')} />
      <span className="truncate">
        {text}
        {needYou > 0 && <span className="text-(--accent-orange-text)"> · {needYou} {needYou === 1 ? 'needs' : 'need'} you</span>}
      </span>
      <ChevronDown size={12} aria-hidden="true" className="shrink-0 text-(--color-text-muted)" />
    </>
  )
}

/**
 * A background command: what the agent called it (else the command), its
 * number and how long it has run, and Stop. It opens nothing, so the row is
 * not a button.
 */
function CommandRow({ item, onStop, stopping }: { item: WaitingItem; onStop: (number: number) => void; stopping: boolean }) {
  const clock = useElapsedClock(typeof item.started_at === 'number' ? item.started_at * 1000 : null, true)
  const number = item.number ?? 0
  return (
    <li className={ROW_CLASS}>
      <span className="min-w-0 flex-1">
        <span className={cn('block truncate text-xs font-medium text-(--color-text)', !item.title && 'font-mono')}>{item.title || item.label}</span>
        <span className="block truncate text-meta text-(--color-text-muted)">
          Command {number}{clock ? ` · ${clock}` : ''}{item.waited ? '' : ' · keeps running'}
        </span>
      </span>
      {item.waited && <Chip tone={STATUS.running.tone} spinner>{STATUS.running.label}</Chip>}
      <Button type="button" size="xs" disabled={stopping} aria-label={`Stop command ${number}`} onClick={() => onStop(number)}>Stop</Button>
    </li>
  )
}

function WaitingRows({ items, onOpen, onStop, stopping }: { items: readonly WaitingItem[]; onOpen: (item: WaitingItem) => void; onStop: (number: number) => void; stopping: number | null }) {
  return (
    <ul className="flex flex-col">
      {items.map((item) => {
        if (item.kind === 'command') return <CommandRow key={`command-${item.number}`} item={item} onStop={onStop} stopping={stopping === item.number} />
        const status = STATE[item.state]
        return (
          <li key={item.session_id}>
            <button
              type="button"
              onClick={() => onOpen(item)}
              className={cn(ROW_CLASS, 'transition-colors duration-(--motion-instant) pointer-fine:hover:bg-(--bg-key) active:bg-(--bg-key) focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-(--focus-ring)')}
            >
              <span className="min-w-0 flex-1">
                <span className="block truncate text-xs font-medium text-(--color-text)">{item.title || 'Untitled session'}</span>
                <span className="block truncate text-meta text-(--color-text-muted)">{item.kind === 'subagent' ? `Subagent · ${item.label}` : item.label}</span>
              </span>
              <Chip tone={status.tone} spinner={status.spinner} dot={item.state === 'needs_input'}>{status.label}</Chip>
            </button>
          </li>
        )
      })}
    </ul>
  )
}

export function WaitingForLine({ sessionId }: { sessionId: string | undefined }) {
  const isPhone = useIsPhone()
  const [open, setOpen] = useState(false)
  const client = useContext(QueryClientContext)
  const options = sessionWaitingQuery(sessionId)
  const items = activeWaiting(useQuery({ ...options, enabled: options.enabled && Boolean(client) }, client ?? NO_CLIENT).data?.items)
  const stop = useStopCommand(sessionId, client ?? NO_CLIENT)
  const counts = countWaiting(items)
  const text = waitingText(counts)
  if (!text) return null
  // Something is coming back, or only servers run.
  const awaiting = counts.sessions + counts.commands > 0
  const listLabel = awaiting ? 'Waiting for' : 'Running commands'

  const openSession = (item: WaitingItem) => {
    setOpen(false)
    requestOpenSession({ sessionId: item.session_id, workspace: item.workspace })
  }
  const rows = <WaitingRows items={items} onOpen={openSession} onStop={(number) => stop.mutate(number)} stopping={stop.isPending ? stop.variables ?? null : null} />

  if (isPhone) {
    return (
      <div data-waiting-for="" className="flex min-w-0">
        <button type="button" aria-haspopup="dialog" aria-expanded={open} onClick={() => setOpen(true)} className={TRIGGER_CLASS}>
          <TriggerText text={text} counts={counts} />
        </button>
        <BottomSheet open={open} onClose={() => setOpen(false)} label={listLabel}>
          <div data-waiting-sheet="" className="flex flex-col gap-2 px-2 pb-4">
            {awaiting && <p className="px-2 text-xs text-(--color-text-muted)">The main agent goes on when these report back.</p>}
            {rows}
          </div>
        </BottomSheet>
      </div>
    )
  }

  return (
    <div data-waiting-for="" className="flex min-w-0">
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger aria-haspopup="dialog" className={TRIGGER_CLASS}>
          <TriggerText text={text} counts={counts} />
        </PopoverTrigger>
        <PopoverContent align="start" side="top" role="dialog" aria-label={listLabel} className={cn('w-[min(22rem,calc(100vw-1rem))] gap-1 p-1.5')}>
          {rows}
        </PopoverContent>
      </Popover>
    </div>
  )
}
