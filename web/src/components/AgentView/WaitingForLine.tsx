/**
 * WaitingForLine — under a finished answer whose session still has work
 * coming back to it: subagents still running, and sessions in other
 * workspaces that owe it a reply. The answer above is not the last word, and
 * this says so where the reader looks: "Waiting for 3 sessions", with a list
 * that opens each one (a popover; a sheet on a phone).
 *
 * Nothing renders when the session waits for nothing. The count is one
 * number for both kinds: a subagent is a session you can open too, and the
 * list says which is which.
 */
import { useContext, useState } from 'react'
import { QueryClient, QueryClientContext, useQuery } from '@tanstack/react-query'
import { ChevronDown } from 'lucide-react'

import type { WaitingItem } from '@/api/types'
import { BottomSheet } from '@/components/ui/bottom-sheet'
import { Chip } from '@/components/ui/chip'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { useIsPhone } from '@/hooks/use-is-phone'
import { STATUS, type StatusView } from '@/lib/status'
import { cn } from '@/lib/utils'
import { sessionWaitingQuery } from '@/queries/useSessionsQuery'
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

function plural(n: number, one: string): string {
  return `${n} ${n === 1 ? one : `${one}s`}`
}

/** `Waiting for 3 sessions`, and `· 1 needs you` when any is stopped on the person. */
function TriggerText({ items }: { items: readonly WaitingItem[] }) {
  const needYou = items.filter((item) => item.state === 'needs_input').length
  return (
    <>
      <span aria-hidden="true" className="size-1.5 shrink-0 rounded-full bg-(--color-text) animate-pulse motion-reduce:animate-none" />
      <span className="truncate">
        Waiting for {plural(items.length, 'session')}
        {needYou > 0 && <span className="text-(--accent-orange-text)"> · {needYou} {needYou === 1 ? 'needs' : 'need'} you</span>}
      </span>
      <ChevronDown size={12} aria-hidden="true" className="shrink-0 text-(--color-text-muted)" />
    </>
  )
}

function WaitingRows({ items, onOpen }: { items: readonly WaitingItem[]; onOpen: (item: WaitingItem) => void }) {
  return (
    <ul className="flex flex-col">
      {items.map((item) => {
        const status = STATE[item.state]
        return (
          <li key={item.session_id}>
            <button
              type="button"
              onClick={() => onOpen(item)}
              className="flex min-h-9 w-full items-center gap-3 rounded-sm px-2 py-1 text-left transition-colors duration-(--motion-instant) pointer-fine:hover:bg-(--bg-key) active:bg-(--bg-key) focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-(--focus-ring) max-md:pointer-coarse:min-h-(--phone-control)"
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
  const items = useQuery({ ...options, enabled: options.enabled && Boolean(client) }, client ?? NO_CLIENT).data?.items ?? []
  if (items.length === 0) return null

  const openSession = (item: WaitingItem) => {
    setOpen(false)
    requestOpenSession({ sessionId: item.session_id, workspace: item.workspace })
  }

  if (isPhone) {
    return (
      <div data-waiting-for="" className="flex min-w-0">
        <button type="button" aria-haspopup="dialog" aria-expanded={open} onClick={() => setOpen(true)} className={TRIGGER_CLASS}>
          <TriggerText items={items} />
        </button>
        <BottomSheet open={open} onClose={() => setOpen(false)} label="Waiting for">
          <div data-waiting-sheet="" className="flex flex-col gap-2 px-2 pb-4">
            <p className="px-2 text-xs text-(--color-text-muted)">The main agent goes on when these report back.</p>
            <WaitingRows items={items} onOpen={openSession} />
          </div>
        </BottomSheet>
      </div>
    )
  }

  return (
    <div data-waiting-for="" className="flex min-w-0">
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger aria-haspopup="dialog" className={TRIGGER_CLASS}>
          <TriggerText items={items} />
        </PopoverTrigger>
        <PopoverContent align="start" side="top" role="dialog" aria-label="Waiting for" className={cn('w-[min(22rem,calc(100vw-1rem))] gap-1 p-1.5')}>
          <WaitingRows items={items} onOpen={openSession} />
        </PopoverContent>
      </Popover>
    </div>
  )
}
