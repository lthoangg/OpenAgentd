import { useEffect, useState } from 'react'
import { ArrowDown, ArrowUp, Loader2 } from 'lucide-react'

import type { ProviderInfo, StoredCredential } from '@/api/client'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  useDeleteProviderCredentialMutation,
  useDisconnectOauthProviderMutation,
  useOrderProviderCredentialsMutation,
  useProviderUsageQuery,
  useUpdateProviderCredentialMutation,
} from '@/queries'
import { useToastStore } from '@/stores/useToastStore'
import { errorMessage } from '@/utils/errors'
import { UsagePanel } from './UsagePanel'
import { supportsCredentialUsage } from './providerUtils'

const PILL = 'inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-medium'
const PILL_MUTED = `${PILL} border-(--color-border) bg-(--bg-key) text-(--color-text-muted)`
const PILL_OK = `${PILL} border-(--color-success)/15 bg-(--color-success-subtle) text-(--color-success)`
const PILL_INFO = `${PILL} border-transparent bg-(--accent-blue-soft) text-(--accent-blue-text)`
const PILL_WARN = `${PILL} border-transparent bg-(--accent-orange-soft) text-(--accent-orange-text)`
const PILL_ERROR = `${PILL} border-(--color-error)/15 bg-(--color-error-subtle) text-(--color-error)`

/** `1h 42m`, `12m`, `40s` until `untilS` (unix seconds). */
export function formatCountdown(untilS: number, nowMs: number): string {
  const left = Math.max(0, Math.round(untilS - nowMs / 1000))
  const h = Math.floor(left / 3600)
  const m = Math.floor((left % 3600) / 60)
  if (h > 0) return `${h}h ${String(m).padStart(2, '0')}m`
  if (m > 0) return `${m}m`
  return `${left}s`
}

const COOLDOWN_LABEL: Record<string, string> = {
  rate_limit: 'Rate-limited',
  quota: 'Usage limit reached',
  spend_limit: 'Spend limit reached',
  auth: 'Rejected',
}

/** Ticks only while mounted, i.e. only for a credential that is cooling down. */
function CooldownPill({ reason, until }: { reason: string | null; until: number | null }) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!until) return undefined
    const t = window.setInterval(() => setNow(Date.now()), 15_000)
    return () => window.clearInterval(t)
  }, [until])
  return (
    <span className={PILL_WARN}>
      {COOLDOWN_LABEL[reason ?? ''] ?? 'Cooling down'}
      {until ? ` · resets in ${formatCountdown(until, now)}` : ''}
    </span>
  )
}

function StatusPills({ credential, pinned }: { credential: StoredCredential; pinned: boolean }) {
  if (pinned) return <span className={PILL_MUTED}>Standby</span>
  return (
    <>
      {credential.in_use && credential.status !== 'disabled' && <span className={PILL_INFO}>In use</span>}
      {credential.status === 'ready' && <span className={PILL_OK}>Ready</span>}
      {credential.status === 'disabled' && <span className={PILL_MUTED}>Disabled</span>}
      {credential.status === 'needs_reconnect' && <span className={PILL_ERROR}>Reconnect required</span>}
      {credential.status === 'cooling_down' && <CooldownPill reason={credential.cooldown_reason} until={credential.cooldown_until} />}
    </>
  )
}

function AccountUsage({ providerId, credentialId }: { providerId: string; credentialId: string }) {
  const q = useProviderUsageQuery(providerId, true, credentialId)
  if (q.isLoading) {
    return (
      <p className="inline-flex items-center gap-1 font-mono text-[11px] text-(--color-text-subtle)">
        <Loader2 className="h-3 w-3 animate-spin" aria-hidden="true" />
        Loading usage…
      </p>
    )
  }
  if (q.isError || !q.data || q.data.limits.length === 0) {
    return <p className="font-mono text-[11px] text-(--color-text-subtle)">Usage unavailable for this account right now.</p>
  }
  return <UsagePanel providerId={providerId} credentialId={credentialId} limits={q.data.limits} updatedAt={q.dataUpdatedAt} />
}

/** A provider's stored keys or OAuth accounts, in the order they are tried. */
export function CredentialList({
  provider,
  onReconnect,
}: {
  provider: ProviderInfo
  /** OAuth: sign in again to this account. */
  onReconnect?: (credentialId: string) => void
}) {
  const credentials = provider.stored_credentials ?? []
  const isOauth = provider.kind === 'oauth'
  const pinned = Boolean(provider.env_pinned)
  const [renaming, setRenaming] = useState<{ id: string; value: string } | null>(null)
  const [confirmRemove, setConfirmRemove] = useState<string | null>(null)
  const [usageOpen, setUsageOpen] = useState<string | null>(null)
  const order = useOrderProviderCredentialsMutation()
  const update = useUpdateProviderCredentialMutation()
  const remove = useDeleteProviderCredentialMutation()
  const signOut = useDisconnectOauthProviderMutation()
  const push = useToastStore((s) => s.push)

  const fail = (title: string, err: unknown) => push({ tone: 'error', title, description: errorMessage(err) })

  const move = (index: number, delta: -1 | 1) => {
    const ids = credentials.map((c) => c.id)
    const target = index + delta
    if (target < 0 || target >= ids.length) return
    ;[ids[index], ids[target]] = [ids[target], ids[index]]
    order.mutate({ providerId: provider.id, ids }, { onError: (err) => fail('Could not reorder', err) })
  }

  const saveRename = () => {
    if (!renaming) return
    const label = renaming.value.trim()
    const id = renaming.id
    setRenaming(null)
    if (!label) return
    update.mutate({ providerId: provider.id, credentialId: id, body: { label } }, { onError: (err) => fail('Could not rename', err) })
  }

  const doRemove = async (c: StoredCredential) => {
    setConfirmRemove(null)
    try {
      if (isOauth) await signOut.mutateAsync({ providerId: provider.id, credentialId: c.id })
      else await remove.mutateAsync({ providerId: provider.id, credentialId: c.id })
      push({ tone: 'success', title: isOauth ? 'Account removed' : 'Key removed', description: c.label })
    } catch (err) {
      fail(isOauth ? 'Could not remove account' : 'Could not remove key', err)
    }
  }

  if (credentials.length === 0 && !pinned) return null
  const noun = isOauth ? 'account' : 'key'

  return (
    <div className="overflow-hidden rounded-md border border-(--color-border-subtle)" role="list" aria-label={`${provider.label} ${noun}s`}>
      {pinned && (
        <div role="listitem" className="grid grid-cols-[24px_minmax(0,1fr)] gap-2.5 border-b border-(--color-border-subtle) bg-(--accent-blue-soft)/40 px-3 py-2.5 last:border-b-0">
          <span className="flex h-6 items-center justify-center rounded-sm bg-(--bg-key) text-[11px] font-semibold text-(--color-text-muted)">env</span>
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="text-xs font-semibold text-(--color-text)">From environment</span>
              {provider.env_var && <span className="font-mono text-[11px] text-(--color-text-muted)">{provider.env_var}</span>}
              <span className={PILL_INFO}>In use</span>
              <span className={PILL_MUTED}>Read-only</span>
            </div>
            <p className="mt-0.5 text-[11px] leading-relaxed text-(--color-text-muted)">
              Exported where OpenAgentd was started. Stored {noun}s are not used while it is set.
            </p>
          </div>
        </div>
      )}
      {credentials.map((c, i) => {
        const settingsText = Object.entries(c.settings).map(([k, v]) => `${k}=${v}`).join('  ')
        return (
          <div
            key={c.id}
            role="listitem"
            className={`grid grid-cols-[24px_minmax(0,1fr)] gap-2.5 border-b border-(--color-border-subtle) px-3 py-2.5 last:border-b-0 sm:grid-cols-[24px_minmax(0,1fr)_auto] ${c.in_use && !pinned ? 'bg-(--accent-blue-soft)/30' : ''} ${pinned ? 'opacity-60' : ''}`}
          >
            <span className="flex h-6 items-center justify-center rounded-sm bg-(--bg-key) text-[11px] font-semibold text-(--color-text-muted)">{i + 1}</span>
            <div className="min-w-0">
              {renaming?.id === c.id ? (
                <form
                  className="flex items-center gap-1.5"
                  onSubmit={(e) => {
                    e.preventDefault()
                    saveRename()
                  }}
                >
                  <Input
                    autoFocus
                    aria-label={`New name for ${c.label}`}
                    value={renaming.value}
                    onChange={(e) => setRenaming({ id: c.id, value: e.target.value })}
                    onKeyDown={(e) => {
                      if (e.key === 'Escape') setRenaming(null)
                    }}
                    className="h-7 max-w-56 text-xs"
                  />
                  <Button type="submit" size="xs">Save</Button>
                  <Button type="button" size="xs" variant="ghost" onClick={() => setRenaming(null)}>Cancel</Button>
                </form>
              ) : (
                <div className="flex flex-wrap items-center gap-1.5">
                  <span className="text-xs font-semibold text-(--color-text)">{c.label || c.id}</span>
                  {c.hint && <span className="font-mono text-[11px] text-(--color-text-muted)">{c.hint}</span>}
                  <StatusPills credential={c} pinned={pinned} />
                </div>
              )}
              {settingsText && <p className="mt-0.5 truncate font-mono text-[11px] text-(--color-text-subtle)">{settingsText}</p>}
              {c.status === 'needs_reconnect' && (
                <p className="mt-0.5 text-[11px] text-(--color-text-muted)">The provider ended this sign-in. It is skipped until you reconnect.</p>
              )}
              {usageOpen === c.id && (
                <div className="mt-2">
                  <AccountUsage providerId={provider.id} credentialId={c.id} />
                </div>
              )}
            </div>
            <div className="col-start-2 flex flex-wrap items-center gap-0.5 sm:col-start-3 sm:justify-end">
              {isOauth && onReconnect && (
                <Button
                  type="button"
                  size="xs"
                  variant={c.status === 'needs_reconnect' ? 'primary' : 'ghost'}
                  onClick={() => onReconnect(c.id)}
                >
                  Reconnect
                </Button>
              )}
              {supportsCredentialUsage(provider) && credentials.length > 1 && c.status !== 'needs_reconnect' && (
                <Button type="button" size="xs" variant="ghost" aria-expanded={usageOpen === c.id} onClick={() => setUsageOpen(usageOpen === c.id ? null : c.id)}>
                  Usage
                </Button>
              )}
              {credentials.length > 1 && (
                <>
                  <Button type="button" size="icon-xs" variant="ghost" aria-label={`Move ${c.label} up`} disabled={i === 0 || order.isPending} onClick={() => move(i, -1)}>
                    <ArrowUp size={12} aria-hidden="true" />
                  </Button>
                  <Button
                    type="button"
                    size="icon-xs"
                    variant="ghost"
                    aria-label={`Move ${c.label} down`}
                    disabled={i === credentials.length - 1 || order.isPending}
                    onClick={() => move(i, 1)}
                  >
                    <ArrowDown size={12} aria-hidden="true" />
                  </Button>
                </>
              )}
              <Button type="button" size="xs" variant="ghost" onClick={() => setRenaming({ id: c.id, value: c.label })}>
                Rename
              </Button>
              <Button
                type="button"
                size="xs"
                variant="ghost"
                onClick={() =>
                  update.mutate(
                    { providerId: provider.id, credentialId: c.id, body: { disabled: !c.disabled } },
                    { onError: (err) => fail(c.disabled ? 'Could not enable' : 'Could not disable', err) },
                  )
                }
              >
                {c.disabled ? 'Enable' : 'Disable'}
              </Button>
              {confirmRemove === c.id ? (
                <Button type="button" size="xs" variant="ghost" className="text-(--color-error) hover:text-(--color-error)" onClick={() => void doRemove(c)}>
                  Confirm remove
                </Button>
              ) : (
                <Button type="button" size="xs" variant="ghost" className="text-(--color-error) hover:text-(--color-error)" onClick={() => setConfirmRemove(c.id)}>
                  Remove
                </Button>
              )}
            </div>
          </div>
        )
      })}
    </div>
  )
}
