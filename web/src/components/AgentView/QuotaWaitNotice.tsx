/**
 * A turn waiting for a provider quota to reset: what the wait is (read from
 * its ``provider_status`` block), the one still live, the record that keeps
 * its card up across a reload, and the card itself with its countdown.
 */
import { useEffect, useMemo, useState } from 'react'
import type { ContentBlock } from '@/api/types'
import { Button } from '@/components/ui/button'
import { Callout } from '@/components/ui/callout'
import { ModelName } from '@/components/ui/model-name'
import { useAgentStore } from '@/stores/useAgentStore'
import { CopyDetailsButton } from './ErrorCard'
import { PendingDots } from './PendingDots'
import { isBlankContentBlock, waitAccount } from './provider-status'

interface QuotaWait {
  model?: string
  message?: string
  resetsAt?: number
  /** The session is pinned to the account that ran out: it waits for that one. */
  pinned?: boolean
  /** The account that ran out, when the server names it. */
  account?: string
}

const QUOTA_WAIT_STORAGE_PREFIX = 'openagentd:quota-wait:'

function quotaWaitStorageKey(sessionId: string): string {
  return `${QUOTA_WAIT_STORAGE_PREFIX}${encodeURIComponent(sessionId)}`
}

function readStoredQuotaWait(sessionId: string | undefined): QuotaWait | null {
  if (!sessionId || typeof window === 'undefined') return null

  try {
    const raw = window.localStorage.getItem(quotaWaitStorageKey(sessionId))
    if (!raw) return null
    const stored = JSON.parse(raw) as { model?: unknown; resetsAt?: unknown; pinned?: unknown; account?: unknown; message?: unknown }
    if (typeof stored.resetsAt !== 'number' || !Number.isFinite(stored.resetsAt)) return null
    if (stored.resetsAt <= Date.now() / 1000) {
      window.localStorage.removeItem(quotaWaitStorageKey(sessionId))
      return null
    }
    return {
      model: typeof stored.model === 'string' ? stored.model : undefined,
      resetsAt: stored.resetsAt,
      // A pinned wait keeps its own card (and its ways around) after a reload.
      pinned: stored.pinned === true,
      account: typeof stored.account === 'string' ? stored.account : undefined,
      message: typeof stored.message === 'string' ? stored.message : undefined,
    }
  } catch {
    return null
  }
}

function saveQuotaWait(sessionId: string | undefined, wait: QuotaWait): void {
  if (!sessionId || wait.resetsAt === undefined || typeof window === 'undefined') return

  try {
    window.localStorage.setItem(
      quotaWaitStorageKey(sessionId),
      JSON.stringify({ model: wait.model, resetsAt: wait.resetsAt, pinned: wait.pinned, account: wait.account, message: wait.message }),
    )
  } catch {
    // Storage can be unavailable in private browsing or when disabled.
  }
}

function removeStoredQuotaWait(sessionId: string | undefined): void {
  if (!sessionId || typeof window === 'undefined') return
  try {
    window.localStorage.removeItem(quotaWaitStorageKey(sessionId))
  } catch {
    // Storage can be unavailable in private browsing or when disabled.
  }
}

export function quotaWaitFromBlock(block: ContentBlock): QuotaWait | null {
  if (block.type !== 'provider_status' || !block.extra) return null
  const status = block.extra.status
  if (status !== 'waiting_quota' && status !== 'waiting_credential') return null

  const model = typeof block.extra.model === 'string' ? block.extra.model : undefined
  const resetsAt = typeof block.extra.resets_at === 'number' && Number.isFinite(block.extra.resets_at)
    ? block.extra.resets_at
    : typeof block.extra.retry_after === 'number' && Number.isFinite(block.extra.retry_after)
    ? Date.now() / 1000 + block.extra.retry_after
    : undefined
  return {
    model,
    message: typeof block.extra.message === 'string' ? block.extra.message : undefined,
    resetsAt,
    pinned: status === 'waiting_credential',
    account: waitAccount(block.extra),
  }
}

function latestActiveQuotaWait(
  finalizedBlocks: ContentBlock[],
  liveBlocks: ContentBlock[],
): { blockId: string; wait: QuotaWait } | null {
  for (const part of [liveBlocks, finalizedBlocks]) {
    for (let index = part.length - 1; index >= 0; index -= 1) {
      const block = part[index]
      if (isBlankContentBlock(block)) continue
      const wait = quotaWaitFromBlock(block)
      return wait ? { blockId: block.id, wait } : null
    }
  }
  return null
}

/**
 * The quota wait the transcript shows: the live one while the turn is open,
 * else, after a reload that has loaded nothing yet, the one stored for the
 * session. A record no wait shows any more is dropped.
 */
export function useQuotaWait({ blocks, liveTail, isTurnOpen, sessionId, held }: {
  blocks: ContentBlock[]
  liveTail: ContentBlock[]
  isTurnOpen: boolean
  sessionId: string | undefined
  /** A switch holds another session's transcript on screen. */
  held: boolean
}) {
  // Not compiled, as when this code was part of AgentView, which the React
  // Compiler skipped; compiling it is a change of its own to verify.
  'use no memo'
  const activeQuotaWait = useMemo(
    () => latestActiveQuotaWait(blocks, liveTail),
    [blocks, liveTail],
  )
  const activeBlockId = isTurnOpen ? activeQuotaWait?.blockId : undefined
  const liveQuotaWait = isTurnOpen ? activeQuotaWait?.wait ?? null : null
  const storedQuotaWait = useMemo(() => readStoredQuotaWait(sessionId), [sessionId])
  const canRestoreStoredQuotaWait = isTurnOpen && !liveQuotaWait && blocks.length + liveTail.length === 0

  const restored = canRestoreStoredQuotaWait ? storedQuotaWait : null
  const visible = liveQuotaWait ?? restored

  useEffect(() => {
    // A held transcript is not the session's live state: keep its record.
    if (!sessionId || held) return
    if (!visible) removeStoredQuotaWait(sessionId)
  }, [held, sessionId, visible])

  return { activeBlockId, restored, visible }
}

/** Time left until a quota resets, for "resumes in …": ``2h 05m``. */
function formatQuotaCountdown(resetsAt: number, now = Date.now()): string | null {
  const remainingSeconds = resetsAt - now / 1000
  if (remainingSeconds <= 0) return null

  const totalMinutes = Math.ceil(remainingSeconds / 60)
  if (totalMinutes < 1) return '<1m'

  const days = Math.floor(totalMinutes / (24 * 60))
  const hours = Math.floor((totalMinutes % (24 * 60)) / 60)
  const minutes = totalMinutes % 60
  if (days > 0) return `${days}d ${String(hours).padStart(2, '0')}h`
  if (hours > 0) return `${hours}h ${String(minutes).padStart(2, '0')}m`
  return `${minutes}m`
}

/**
 * The turn is waiting for a provider quota to reset (DESIGN.md → Notices):
 * one card, for one account or (a provider with several) every account at
 * its limit. Calm on purpose: it resolves itself, so no pulse and no alarm
 * words. Stop is always on the card. The provider's own message is one
 * "Copy details" away. ``pinned`` cards come from older transcripts, when a
 * locked session waited for its own account.
 */
export function QuotaWaitNotice({ wait, sessionId, persist }: { wait: QuotaWait; sessionId?: string; persist: boolean }) {
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    const interval = window.setInterval(() => setNow(Date.now()), 60_000)
    return () => window.clearInterval(interval)
  }, [])

  // Wake at the reset itself, not up to a minute after it.
  useEffect(() => {
    if (wait.resetsAt === undefined) return undefined
    const ms = wait.resetsAt * 1000 - Date.now()
    if (ms <= 0 || ms > 2_147_000_000) return undefined
    const timer = window.setTimeout(() => setNow(Date.now()), ms + 50)
    return () => window.clearTimeout(timer)
  }, [wait.resetsAt])

  useEffect(() => {
    if (persist) saveQuotaWait(sessionId, { model: wait.model, resetsAt: wait.resetsAt, pinned: wait.pinned, account: wait.account, message: wait.message })
  }, [persist, sessionId, wait.model, wait.resetsAt, wait.pinned, wait.account, wait.message])

  useEffect(() => {
    if (wait.resetsAt !== undefined && now >= wait.resetsAt * 1000) {
      removeStoredQuotaWait(sessionId)
    }
  }, [now, sessionId, wait.resetsAt])

  const countdown = wait.resetsAt === undefined ? undefined : formatQuotaCountdown(wait.resetsAt, now)
  // The quota has reset and the call is out again: the wait is over, so the
  // card (and its Stop / Use Auto) gives way to the same dots as any reply
  // on its way. Without a known reset time the card stays until output comes.
  // A card restored after a reload has no rows under it, where the
  // transcript already shows those dots.
  if (countdown === null) return persist ? <PendingDots /> : null
  const modelName = wait.model ? <ModelName id={wait.model} className="align-bottom text-(--color-text-2)" /> : null
  const accountName = wait.account ? <span className="font-semibold text-(--color-text-2)">{wait.account}</span> : null
  // A provider with several accounts waits only once every one is limited.
  const everyAccount = !wait.pinned && (wait.message ?? '').startsWith('Every account for ')

  return (
    <div className="my-2">
      <Callout
        tone="warning"
        role="status"
        title={
          <>
            {wait.pinned ? 'Waiting for the pinned account' : 'Waiting for quota reset'}
            {countdown !== undefined && (
              <span className="font-normal text-(--color-text-muted)" aria-live="polite">
                {' · resumes in '}<span className="font-mono tabular-nums">{countdown}</span>
              </span>
            )}
          </>
        }
        action={<WaitActions details={wait.message} />}
      >
        <span className="text-(--color-text-muted)">
          {wait.pinned
            ? <>
                {accountName ? <>Account {accountName}</> : 'The pinned account'} hit its usage limit
                {modelName && <>{' on '}{modelName}</>}
                . This session resumes on it when the limit resets.
              </>
            : everyAccount
            ? <>
                Every account{modelName && <>{' for '}{modelName}</>} is at its usage limit. Resumes on the first one that resets.
              </>
            : <>
                {modelName ? <>{modelName} used up its provider quota</> : 'The provider quota is used up'}
                {accountName && <>{' on account '}{accountName}</>}
                . Resumes automatically.
              </>}
        </span>
      </Callout>
    </div>
  )
}

/**
 * The ways out of a wait, on the card itself: Stop, and Copy details for the
 * provider's own message. A wait means no account has room, so there is no
 * other account to go on with.
 */
function WaitActions({ details }: { details?: string }) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Button type="button" size="sm" variant="ghost" onClick={() => void useAgentStore.getState().stopAgent()}>
        Stop
      </Button>
      {details && <CopyDetailsButton text={details} size="sm" />}
    </div>
  )
}
