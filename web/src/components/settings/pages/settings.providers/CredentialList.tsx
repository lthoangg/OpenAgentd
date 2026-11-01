import { useEffect, useState, type ReactNode } from 'react'
import { MoreHorizontal } from 'lucide-react'

import type { ProviderInfo, StoredCredential } from '@/api/client'
import { Button } from '@/components/ui/button'
import { Chip } from '@/components/ui/chip'
import { Dropdown, DropdownItem } from '@/components/ui/dropdown'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'
import { Input } from '@/components/ui/input'
import {
  useDeleteProviderCredentialMutation,
  useDisconnectOauthProviderMutation,
  useOrderProviderCredentialsMutation,
  useUpdateProviderCredentialMutation,
} from '@/queries'
import { useToastStore } from '@/stores/useToastStore'
import { errorMessage } from '@/utils/errors'
import { UsageScope } from './ProfileUsage'
import { supportsCredentialUsage, supportsUsage } from './providerUtils'

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
    <Chip tone="warning">
      {COOLDOWN_LABEL[reason ?? ''] ?? 'Cooling down'}
      {until ? ` · resets in ${formatCountdown(until, now)}` : ''}
    </Chip>
  )
}

function StatusPills({ credential, pinned }: { credential: StoredCredential; pinned: boolean }) {
  if (pinned) return <Chip title="Not used while the environment variable is set">Standby</Chip>
  return (
    <>
      {credential.in_use && credential.status !== 'disabled' && <Chip tone="info">In use</Chip>}
      {credential.status === 'ready' && <Chip tone="success">Ready</Chip>}
      {credential.status === 'disabled' && <Chip>Disabled</Chip>}
      {credential.status === 'needs_reconnect' && <Chip tone="error">Reconnect required</Chip>}
      {credential.status === 'cooling_down' && <CooldownPill reason={credential.cooldown_reason} until={credential.cooldown_until} />}
    </>
  )
}

/** API-key "Show usage": the provider's key-level usage under that key, opened on demand. */
function KeyUsage({ providerId, providerLabel, credentialId, label }: { providerId: string; providerLabel: string; credentialId: string; label: string }) {
  return (
    <UsageScope providerId={providerId} providerLabel={providerLabel} credentialId={credentialId} label={label} title="Usage" emptyText="Usage is unavailable right now.">
      {({ body }) => body}
    </UsageScope>
  )
}

const LIST_CLASS = 'overflow-hidden rounded-md border border-(--color-border-subtle)'
const ROW_BORDER = 'border-b border-(--color-border-subtle) last:border-b-0'

/**
 * One profile's header line (identity left; Refresh, a visible Reconnect/Enable
 * when needed, and the management menu right), with the usage below it.
 * Wrapping, not squeezing: on a narrow screen the actions drop under the name.
 */
function ProfileShell({
  identity,
  actions,
  note,
  body,
  className,
  ...rest
}: {
  identity: ReactNode
  actions?: ReactNode
  note?: ReactNode
  body?: ReactNode
  className?: string
  'data-credential-id'?: string
}) {
  return (
    <div role="listitem" className={`${ROW_BORDER} px-3 py-3 ${className ?? ''}`} {...rest}>
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1.5">
        <div className="flex min-w-0 flex-1 basis-48 flex-wrap items-center gap-x-2 gap-y-1">{identity}</div>
        {actions && <div className="flex shrink-0 items-center gap-1">{actions}</div>}
      </div>
      {note}
      {body && <div className="mt-3">{body}</div>}
    </div>
  )
}

/**
 * The sign-in itself, for a provider that reports usage but not per account
 * (or has no stored accounts): one explicit row, never an outer block.
 */
export function ProviderSignInRow({
  provider,
  accountInUse,
  onReconnect,
}: {
  provider: ProviderInfo
  /** Stored accounts exist, so this is the usage of whichever one is in use. */
  accountInUse: boolean
  onReconnect?: () => void
}) {
  return (
    <div role="list" aria-label={`${provider.label} sign-in`} className={LIST_CLASS}>
      <UsageScope providerId={provider.id} providerLabel={provider.label} label="Provider sign-in" onReconnect={onReconnect} emptyText="No usage details reported.">
        {({ plan, refresh, body }) => (
          <ProfileShell
            identity={
              <>
                <span className="text-xs font-semibold text-(--color-text)">Provider sign-in</span>
                {plan && <Chip>{plan}</Chip>}
                {accountInUse && <span className="text-[11px] text-(--color-text-muted)">Account in use</span>}
              </>
            }
            actions={refresh}
            body={body}
          />
        )}
      </UsageScope>
    </div>
  )
}

interface RowContext {
  provider: ProviderInfo
  count: number
  pinned: boolean
  busy: boolean
  onReconnect?: (credentialId: string) => void
  startRename: (c: StoredCredential) => void
  move: (index: number, delta: -1 | 1) => void
  toggle: (c: StoredCredential) => void
  askRemove: (id: string) => void
  renaming: { id: string; value: string } | null
  setRenaming: (value: { id: string; value: string } | null) => void
  saveRename: () => void
}

function RenameForm({ c, ctx }: { c: StoredCredential; ctx: RowContext }) {
  const { renaming, setRenaming, saveRename } = ctx
  if (renaming?.id !== c.id) return null
  return (
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
        className="h-7 max-w-56 text-xs pointer-coarse:h-9"
      />
      <Button type="submit" size="xs">Save</Button>
      <Button type="button" size="xs" variant="ghost" onClick={() => setRenaming(null)}>Cancel</Button>
    </form>
  )
}

/** Everything that manages one OAuth profile, behind one always-visible menu button (works on touch and keyboard). */
function ManageMenu({ c, index, ctx }: { c: StoredCredential; index: number; ctx: RowContext }) {
  const { count, busy, onReconnect } = ctx
  const items: ReactNode[] = [
    <DropdownItem key="rename" onSelect={() => ctx.startRename(c)}>Rename</DropdownItem>,
    count > 1 ? (
      <DropdownItem key="up" disabled={index === 0 || busy} onSelect={() => ctx.move(index, -1)}>Try earlier</DropdownItem>
    ) : null,
    count > 1 ? (
      <DropdownItem key="down" disabled={index === count - 1 || busy} onSelect={() => ctx.move(index, 1)}>Try later</DropdownItem>
    ) : null,
    onReconnect ? <DropdownItem key="reconnect" onSelect={() => onReconnect(c.id)}>Reconnect</DropdownItem> : null,
    <DropdownItem key="toggle" onSelect={() => ctx.toggle(c)}>{c.disabled ? 'Enable' : 'Disable'}</DropdownItem>,
    <DropdownItem key="remove" className="text-(--color-error)" onSelect={() => ctx.askRemove(c.id)}>Remove…</DropdownItem>,
  ].filter(Boolean)
  return (
    <Dropdown
      aria-label={`Manage ${c.label || c.id}`}
      trigger={<MoreHorizontal size={14} aria-hidden="true" />}
      align="end"
      className="h-7 min-w-0 gap-1 border-transparent bg-transparent px-1.5 text-(--color-text-muted) shadow-none hover:bg-(--bg-key) hover:text-(--color-text)"
    >
      {items}
    </Dropdown>
  )
}

function OAuthIdentity({ c, index, ctx, plan }: { c: StoredCredential; index: number; ctx: RowContext; plan: string | null }) {
  if (ctx.renaming?.id === c.id) return <RenameForm c={c} ctx={ctx} />
  return (
    <>
      <span className="min-w-3 text-[11px] tabular-nums text-(--color-text-subtle)">{index + 1}</span>
      <span className="text-xs font-semibold text-(--color-text)">{c.label || c.id}</span>
      {plan && <Chip>{plan}</Chip>}
      <StatusPills credential={c} pinned={ctx.pinned} />
    </>
  )
}

/** An enabled, signed-in account: it owns a usage query for as long as the row is mounted. */
function ActiveOAuthRow({ c, index, ctx }: { c: StoredCredential; index: number; ctx: RowContext }) {
  return (
    <UsageScope
      providerId={ctx.provider.id}
      providerLabel={ctx.provider.label}
      credentialId={c.id}
      label={c.label || c.id}
      onReconnect={ctx.onReconnect ? () => ctx.onReconnect?.(c.id) : undefined}
      emptyText="No usage details reported."
    >
      {({ plan, refresh, body }) => (
        <ProfileShell
          data-credential-id={c.id}
          className={`${c.in_use && !ctx.pinned ? 'bg-(--accent-blue-soft)/30' : ''} ${ctx.pinned ? 'opacity-70' : ''}`}
          identity={<OAuthIdentity c={c} index={index} ctx={ctx} plan={plan} />}
          actions={
            <>
              {refresh}
              <ManageMenu c={c} index={index} ctx={ctx} />
            </>
          }
          body={body}
        />
      )}
    </UsageScope>
  )
}

/** A disabled or signed-out account: management only, and it never starts a usage request. */
function IdleOAuthRow({ c, index, ctx }: { c: StoredCredential; index: number; ctx: RowContext }) {
  const needsReconnect = c.status === 'needs_reconnect'
  return (
    <ProfileShell
      data-credential-id={c.id}
      className={ctx.pinned ? 'opacity-70' : ''}
      identity={<OAuthIdentity c={c} index={index} ctx={ctx} plan={null} />}
      actions={
        <>
          {needsReconnect && ctx.onReconnect && (
            <Button type="button" size="xs" variant="primary" className="pointer-coarse:min-h-9" onClick={() => ctx.onReconnect?.(c.id)}>Reconnect</Button>
          )}
          {c.disabled && (
            <Button type="button" size="xs" variant="ghost" className="pointer-coarse:min-h-9" onClick={() => ctx.toggle(c)}>Enable</Button>
          )}
          <ManageMenu c={c} index={index} ctx={ctx} />
        </>
      }
      note={needsReconnect ? <p className="mt-1.5 text-[11px] text-(--color-text-muted)">The provider ended this sign-in. It is skipped until you reconnect.</p> : undefined}
    />
  )
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
  const perAccountUsage = isOauth && supportsCredentialUsage(provider)
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

  const toggle = (c: StoredCredential) =>
    update.mutate(
      { providerId: provider.id, credentialId: c.id, body: { disabled: !c.disabled } },
      { onError: (err) => fail(c.disabled ? 'Could not enable' : 'Could not disable', err) },
    )

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

  const ctx: RowContext = {
    provider,
    count: credentials.length,
    pinned,
    busy: order.isPending,
    onReconnect,
    startRename: (c) => setRenaming({ id: c.id, value: c.label }),
    move,
    toggle,
    askRemove: setConfirmRemove,
    renaming,
    setRenaming,
    saveRename,
  }

  return (
    <div className={LIST_CLASS} role="list" aria-label={`${provider.label} ${noun}s`}>
      {pinned && (
        <div role="listitem" className={`${ROW_BORDER} bg-(--accent-blue-soft)/40 px-3 py-3`}>
          {isOauth && perAccountUsage ? (
            // The exported credential has its own usage, read without an account id.
            <UsageScope providerId={provider.id} providerLabel={provider.label} label="From environment" emptyText="No usage details reported.">
              {({ plan, refresh, body }) => (
                <div className="space-y-3">
                  <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1.5">
                    <div className="flex min-w-0 flex-1 basis-48 flex-wrap items-center gap-x-2 gap-y-1">
                      <span className="text-xs font-semibold text-(--color-text)">From environment</span>
                      {provider.env_var && <span className="font-mono text-[11px] text-(--color-text-muted)">{provider.env_var}</span>}
                      {plan && <Chip>{plan}</Chip>}
                      <Chip tone="info">In use</Chip>
                      <Chip>Read-only</Chip>
                    </div>
                    <div className="flex shrink-0 items-center gap-1">{refresh}</div>
                  </div>
                  <p className="text-[11px] leading-relaxed text-(--color-text-muted)">
                    Set in the environment when OpenAgentd started. Stored {noun}s are on standby while it is set.
                  </p>
                  {body}
                </div>
              )}
            </UsageScope>
          ) : (
            <div className="grid grid-cols-[24px_minmax(0,1fr)] gap-2.5">
              <span className="flex h-6 items-center justify-center rounded-sm bg-(--bg-key) text-[11px] font-semibold text-(--color-text-muted)">env</span>
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-1.5">
                  <span className="text-xs font-semibold text-(--color-text)">From environment</span>
                  {provider.env_var && <span className="font-mono text-[11px] text-(--color-text-muted)">{provider.env_var}</span>}
                  <Chip tone="info">In use</Chip>
                  <Chip>Read-only</Chip>
                </div>
                <p className="mt-0.5 text-[11px] leading-relaxed text-(--color-text-muted)">
                  Set in the environment when OpenAgentd started. Stored {noun}s are on standby while it is set.
                </p>
              </div>
            </div>
          )}
        </div>
      )}
      {credentials.map((c, i) => {
        if (isOauth) {
          // "Hidden from pickers" is not "disabled": only an off or signed-out account skips usage.
          const usageActive = perAccountUsage && supportsUsage(provider) && !c.disabled && c.status !== 'disabled' && c.status !== 'needs_reconnect'
          return usageActive
            ? <ActiveOAuthRow key={c.id} c={c} index={i} ctx={ctx} />
            : <IdleOAuthRow key={c.id} c={c} index={i} ctx={ctx} />
        }
        const settingsText = Object.entries(c.settings).map(([k, v]) => `${k}=${v}`).join('  ')
        return (
          <div
            key={c.id}
            role="listitem"
            className={`grid grid-cols-[24px_minmax(0,1fr)] gap-2.5 ${ROW_BORDER} px-3 py-2.5 sm:grid-cols-[24px_minmax(0,1fr)_auto] ${c.in_use && !pinned ? 'bg-(--accent-blue-soft)/30' : ''} ${pinned ? 'opacity-60' : ''}`}
          >
            <span className="flex h-6 items-center justify-center rounded-sm bg-(--bg-key) text-[11px] font-semibold text-(--color-text-muted)">{i + 1}</span>
            <div className="min-w-0">
              {renaming?.id === c.id ? (
                <RenameForm c={c} ctx={ctx} />
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
                  <KeyUsage providerId={provider.id} providerLabel={provider.label} credentialId={c.id} label={c.label || c.id} />
                </div>
              )}
            </div>
            <div className="col-start-2 flex flex-wrap items-center gap-0.5 sm:col-start-3 sm:justify-end">
              <Button type="button" size="xs" variant="ghost" onClick={() => setRenaming({ id: c.id, value: c.label })}>
                Rename
              </Button>
              <Button type="button" size="xs" variant="ghost" className="text-(--color-error) hover:text-(--color-error)" onClick={() => setConfirmRemove(c.id)}>
                Remove…
              </Button>
              <Dropdown
                aria-label={`More actions for ${c.label || c.id}`}
                trigger="More"
                align="end"
                className="h-6 min-w-0 gap-1 border-transparent bg-transparent px-2 text-xs font-normal text-(--color-text-muted) shadow-none hover:bg-(--bg-key) hover:text-(--color-text)"
              >
                {[
                  supportsCredentialUsage(provider) && credentials.length > 1 && c.status !== 'needs_reconnect' && !c.disabled ? (
                    <DropdownItem key="usage" onSelect={() => setUsageOpen(usageOpen === c.id ? null : c.id)}>
                      {usageOpen === c.id ? 'Hide usage' : 'Show usage'}
                    </DropdownItem>
                  ) : null,
                  credentials.length > 1 ? (
                    <DropdownItem key="up" disabled={i === 0 || order.isPending} onSelect={() => move(i, -1)}>
                      Try earlier
                    </DropdownItem>
                  ) : null,
                  credentials.length > 1 ? (
                    <DropdownItem key="down" disabled={i === credentials.length - 1 || order.isPending} onSelect={() => move(i, 1)}>
                      Try later
                    </DropdownItem>
                  ) : null,
                  <DropdownItem key="toggle" onSelect={() => toggle(c)}>
                    {c.disabled ? 'Enable' : 'Disable'}
                  </DropdownItem>,
                ].filter(Boolean)}
              </Dropdown>
            </div>
          </div>
        )
      })}
      {(() => {
        const target = credentials.find((c) => c.id === confirmRemove)
        return (
          <ConfirmDialog
            open={target !== undefined}
            onOpenChange={(open) => { if (!open) setConfirmRemove(null) }}
            title={isOauth ? `Remove the account “${target?.label ?? ''}”?` : `Remove the key “${target?.label ?? ''}”?`}
            description={isOauth
              ? 'OpenAgentd signs out of this account. Sign in again to use it.'
              : 'The key is deleted from this computer. Add it again to use it.'}
            confirmLabel={isOauth ? 'Remove account' : 'Remove key'}
            onConfirm={() => (target ? doRemove(target) : undefined)}
          />
        )
      })()}
    </div>
  )
}
