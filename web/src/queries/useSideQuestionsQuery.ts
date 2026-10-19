/**
 * `/btw` side questions of a session: the stored ones (TanStack Query) with
 * the answer streaming in this tab (``useBtwStore``) merged in.
 *
 * Nothing here loads with a session: the list is fetched only while the
 * side questions are on screen (the panel above the composer is open, or the
 * caller says so: the dock tab), and the count (for the reopen chip) only
 * when the caller enables it.
 */
import { useEffect, useMemo, useRef } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { countSideQuestions, listSideQuestions } from '@/api/client'
import type { SideQuestion, SideQuestionStatus } from '@/api/types'
import { selectBtw, useBtwStore, type BtwLive } from '@/stores/useBtwStore'
import { queryKeys } from './keys'

/** How often an answer streaming elsewhere (another tab, before a reload) is re-read. */
const STORED_STREAMING_POLL_MS = 1500

export interface BtwExchange {
  /** Stable React key. */
  key: string
  /** Server id; ``null`` until the live answer's ``btw_start``. */
  id: string | null
  question: string
  answer: string
  status: SideQuestionStatus
  error: string | null
  /** Streaming in this tab (``useBtwStore``), not just stored. */
  live: boolean
}

/** Stored side questions, oldest first, with this tab's live answer in place of its row. */
export function mergeLive(items: readonly SideQuestion[], live: BtwLive | null): BtwExchange[] {
  const out: BtwExchange[] = items.map((it) => ({
    key: it.id,
    id: it.id,
    question: it.question,
    answer: it.answer,
    status: it.status,
    error: it.error,
    live: false,
  }))
  if (!live) return out
  const fromLive: BtwExchange = {
    key: live.id ?? 'live',
    id: live.id,
    question: live.question,
    answer: live.text,
    status: live.status,
    error: live.error,
    live: true,
  }
  const at = live.id ? out.findIndex((e) => e.id === live.id) : -1
  if (at === -1) return [...out, fromLive]
  // The stored row wins once it has ended; until then the live text is newer.
  if (live.status === 'streaming' || out[at].status === 'streaming') out[at] = fromLive
  return out
}

/** Refetch the session's side questions whenever the store says they changed. */
function useRefetchOnRevision(sessionId: string | null | undefined, revision: number) {
  const client = useQueryClient()
  const seen = useRef(revision)
  useEffect(() => {
    if (!sessionId || seen.current === revision) return
    seen.current = revision
    void client.invalidateQueries({ queryKey: queryKeys.sideQuestions.all(sessionId) })
  }, [client, sessionId, revision])
}

export function useSideQuestions(
  sessionId: string | null | undefined,
  { countEnabled, listEnabled }: { countEnabled: boolean; /** Defaults to the panel's ``open``. */ listEnabled?: boolean },
) {
  const state = useBtwStore(selectBtw(sessionId))
  const sid = sessionId ?? ''
  const liveId = state.live?.status === 'streaming' ? state.live.id : null
  const listOn = listEnabled ?? state.open
  useRefetchOnRevision(sessionId, state.revision)

  const list = useQuery({
    queryKey: queryKeys.sideQuestions.list(sid),
    queryFn: () => listSideQuestions(sid),
    enabled: !!sessionId && listOn,
    staleTime: 30_000,
    refetchInterval: (query) =>
      query.state.data?.items.some((it) => it.status === 'streaming' && it.id !== liveId)
        ? STORED_STREAMING_POLL_MS
        : false,
  })
  const count = useQuery({
    queryKey: queryKeys.sideQuestions.count(sid),
    queryFn: () => countSideQuestions(sid),
    enabled: !!sessionId && countEnabled,
    staleTime: 5 * 60_000,
  })

  const items = list.data?.items
  const exchanges = useMemo(() => mergeLive(items ?? [], state.live), [items, state.live])
  return {
    ...state,
    exchanges,
    isLoading: listOn && list.isLoading && !state.live,
    error: list.error,
    /** Stored side questions (for the reopen chip), when the count is enabled. */
    total: Math.max(count.data?.total ?? 0, list.data?.total ?? 0),
  }
}
