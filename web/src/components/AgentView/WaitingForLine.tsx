/**
 * WaitingForLine — at the live end of a session's transcript while it has
 * work coming back to it: subagents still running, and sessions in other
 * workspaces that owe it a reply. It shows while the turn runs and stays
 * after it closes, so the reader sees what is still out: "Waiting for 3
 * sessions", with a list that opens each one. On desktop the list opens
 * inline under the line (a transcript fold, DESIGN.md → Transcript folds);
 * a phone opens it as a sheet, since the transcript's live end sits under
 * the floating composer and the keyboard there.
 *
 * Only sessions running or stopped on the person count (``activeWaiting``);
 * nothing renders when there are none. The count is one number for both
 * kinds: a subagent is a session you can open too, and the list says which
 * is which.
 */
import { useContext, useEffect, useId, useReducer, useState, type KeyboardEvent } from 'react'
import { QueryClient, QueryClientContext, useQuery } from '@tanstack/react-query'
import { ChevronDown } from 'lucide-react'

import type { WaitingItem } from '@/api/types'
import { BottomSheet } from '@/components/ui/bottom-sheet'
import { Chip } from '@/components/ui/chip'
import { Collapsible } from '@/components/ui/collapsible'
import { useIsPhone } from '@/hooks/use-is-phone'
import { PINNED_HEADER, useCloseInPlace } from '@/hooks/useStickyFold'
import { STATUS, type StatusView } from '@/lib/status'
import { cn } from '@/lib/utils'
import { activeWaiting, sessionWaitingQuery } from '@/queries/useSessionsQuery'
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

/**
 * Which sessions have their list open, for this run of the app: switching
 * away and back keeps it, a reload starts closed, and a list that empties
 * forgets it.
 */
const OPEN = new Set<string>()

/** Test seam: forget every open list. */
export function resetWaitingOpenState(): void {
  OPEN.clear()
}

/** The same pill as the footer's files toggle: 24px, 36px on touch, 28px on a phone. */
const TRIGGER_CLASS = 'relative touch-hit inline-flex h-6 min-w-0 max-w-full items-center gap-1.5 rounded-xs px-1.5 text-xs text-(--color-text-2) transition-colors duration-(--motion-instant) hover:bg-(--bg-key) hover:text-(--color-text) aria-expanded:bg-(--bg-key) aria-expanded:text-(--color-text) focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-(--focus-ring) pointer-coarse:h-9 pointer-coarse:px-2.5 max-md:pointer-coarse:h-7 max-md:pointer-coarse:px-1.5'

function plural(n: number, one: string): string {
  return `${n} ${n === 1 ? one : `${one}s`}`
}

/** `Waiting for 3 sessions`, and `· 1 needs you` when any is stopped on the person. */
function TriggerText({ items, open }: { items: readonly WaitingItem[]; open: boolean }) {
  const needYou = items.filter((item) => item.state === 'needs_input').length
  return (
    <>
      <span aria-hidden="true" className="size-1.5 shrink-0 rounded-full bg-(--color-text) animate-pulse motion-reduce:animate-none" />
      <span className="truncate">
        Waiting for {plural(items.length, 'session')}
        {needYou > 0 && <span className="text-(--accent-orange-text)"> · {needYou} {needYou === 1 ? 'needs' : 'need'} you</span>}
      </span>
      <ChevronDown
        size={12}
        aria-hidden="true"
        className={cn('shrink-0 text-(--color-text-muted) transition-transform duration-(--motion-base) ease-(--ease-out) motion-reduce:transition-none', open && 'rotate-180')}
      />
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

/** The list inline: one line per session in the transcript's card (as ``TurnFileList``). */
function InlineRows({ items, onOpen }: { items: readonly WaitingItem[]; onOpen: (item: WaitingItem) => void }) {
  return (
    <ul className="my-1 divide-y divide-(--color-border-subtle) overflow-clip rounded-sm border border-(--color-border-subtle) bg-(--bg-card)">
      {items.map((item) => {
        const status = STATE[item.state]
        return (
          <li key={item.session_id}>
            <button
              type="button"
              onClick={() => onOpen(item)}
              className="flex min-h-(--spacing-list-row) w-full min-w-0 items-center gap-2 px-3 py-1 text-left text-xs transition-colors duration-(--motion-instant) hover:bg-(--bg-key)/60 focus-key:bg-(--bg-key)/60 focus-visible:outline-none pointer-coarse:min-h-9"
            >
              <span className="min-w-0 shrink truncate font-medium text-(--color-text)">{item.title || 'Untitled session'}</span>
              <span className="min-w-0 flex-1 truncate text-meta text-(--color-text-muted)">{item.kind === 'subagent' ? `Subagent · ${item.label}` : item.label}</span>
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
  const [sheetOpen, setSheetOpen] = useState(false)
  const [, rerender] = useReducer((n: number) => n + 1, 0)
  const listId = useId()
  const client = useContext(QueryClientContext)
  const options = sessionWaitingQuery(sessionId)
  const items = activeWaiting(useQuery({ ...options, enabled: options.enabled && Boolean(client) }, client ?? NO_CLIENT).data?.items)
  const empty = items.length === 0
  const open = !empty && Boolean(sessionId && OPEN.has(sessionId))
  const { anchorRef, markClose } = useCloseInPlace(open)

  // Nothing left to wait for: the next list starts closed.
  useEffect(() => {
    if (empty && sessionId) OPEN.delete(sessionId)
  }, [empty, sessionId])

  if (empty) return null

  const setOpen = (next: boolean) => {
    if (!sessionId) return
    if (next) OPEN.add(sessionId)
    else OPEN.delete(sessionId)
    rerender()
  }

  if (isPhone) {
    const openFromSheet = (item: WaitingItem) => {
      setSheetOpen(false)
      requestOpenSession({ sessionId: item.session_id, workspace: item.workspace })
    }
    return (
      <div data-waiting-for="" className="flex min-w-0">
        <button type="button" aria-haspopup="dialog" aria-expanded={sheetOpen} onClick={() => setSheetOpen(true)} className={TRIGGER_CLASS}>
          <TriggerText items={items} open={false} />
        </button>
        <BottomSheet open={sheetOpen} onClose={() => setSheetOpen(false)} label="Waiting for">
          <div data-waiting-sheet="" className="flex flex-col gap-2 px-2 pb-4">
            <p className="px-2 text-xs text-(--color-text-muted)">The main agent goes on when these report back.</p>
            <WaitingRows items={items} onOpen={openFromSheet} />
          </div>
        </BottomSheet>
      </div>
    )
  }

  // Inline, the list stays open after a row opens its session: coming back
  // finds it as it was left.
  const openInline = (item: WaitingItem) => requestOpenSession({ sessionId: item.session_id, workspace: item.workspace })
  // Escape anywhere in the list folds it and hands focus back to the line.
  const onListKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'Escape' || !anchorRef.current) return
    event.stopPropagation()
    markClose(anchorRef.current)
    setOpen(false)
    anchorRef.current.focus()
  }

  return (
    <div data-waiting-for="" className="flex min-w-0 flex-col">
      {/* Open, the line pins to the top of the transcript so it can close from anywhere. */}
      <div className={cn('flex min-w-0', open && cn(PINNED_HEADER, 'bg-(--bg-page)'))}>
        <button
          ref={anchorRef}
          type="button"
          aria-expanded={open}
          aria-controls={listId}
          onClick={(event) => {
            if (open) markClose(event.currentTarget)
            setOpen(!open)
          }}
          className={TRIGGER_CLASS}
        >
          <TriggerText items={items} open={open} />
        </button>
      </div>
      <Collapsible open={open}>
        <div id={listId} role="region" aria-label="Sessions this one waits for" data-waiting-list="" onKeyDown={onListKeyDown}>
          <InlineRows items={items} onOpen={openInline} />
        </div>
      </Collapsible>
    </div>
  )
}
