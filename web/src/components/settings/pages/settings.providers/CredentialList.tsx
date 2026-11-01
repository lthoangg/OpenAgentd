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
import { cn } from '@/lib/utils'
import { errorMessage } from '@/utils/errors'
import { testCredential, usePinnedSessionCounts } from './credentialApi'
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

/** What the row is, in words: Signed in (an account) or API key. */
function kindLabel(c: StoredCredential): string {
  return c.kind === 'oauth' ? 'Signed in' : 'API key'
}

function StatusChips({ c, ctx }: { c: StoredCredential; ctx: RowContext }) {
  const pins = ctx.pinsFor(c)
  return (
    <>
      {ctx.envPinned ? (
        <Chip>Standby</Chip>
      ) : (
        <>
          {c.in_use && c.status !== 'disabled' && <Chip tone="info">In use</Chip>}
          {c.status === 'ready' && <Chip tone="success">Ready</Chip>}
          {c.status === 'disabled' && <Chip>Hidden</Chip>}
          {c.status === 'needs_reconnect' && <Chip tone="error">Reconnect required</Chip>}
          {c.status === 'cooling_down' && <CooldownPill reason={c.cooldown_reason} until={c.cooldown_until} />}
        </>
      )}
      {pins > 0 && <Chip>{`Pinned by ${pins} ${pins === 1 ? 'session' : 'sessions'}`}</Chip>}
    </>
  )
}

/**
 * The line under a row that says what its status means, so "Standby" or "In
 * use" never lives only in a tooltip. "In use" is what new messages use; a
 * session can still be pinned to another account (the chip counts them).
 */
function rowCaption(c: StoredCredential, ctx: RowContext, index: number): string | null {
  if (ctx.envPinned) {
    return `Standby — not used while ${ctx.provider.env_var || 'the environment variable'} is set.`
  }
  if (c.disabled || c.status === 'disabled') return 'Hidden — saved, but not used until you show it.'
  if (c.status === 'needs_reconnect') return 'The provider ended this sign-in. It is skipped until you reconnect.'
  if (c.status === 'cooling_down') return `Skipped until its limit resets; the next ${ctx.noun} is used meanwhile.`
  if (c.in_use) return 'In use — new messages go to it until it hits its limit.'
  if (ctx.inUseIndex >= 0 && ctx.inUseIndex > index) return `Standby — used if the ${ctx.noun} in use hits its limit.`
  return 'Standby — used when the ones above hit their limit.'
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
 * One profile's header line (identity left; Refresh, a visible Reconnect/Show
 * when needed, and the ⋯ menu right), a caption, and the usage below.
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
    <div role="listitem" className={cn(ROW_BORDER, 'px-3 py-3', className)} {...rest}>
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
                {accountInUse && <span className="text-meta text-(--color-text-muted)">Account in use</span>}
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
  /** An exported environment key or token is in force, so the stored ones wait on standby. */
  envPinned: boolean
  /** "account" for a sign-in, "key" for an API key. */
  noun: 'account' | 'key'
  busy: boolean
  /** Index of the row the provider is using now, or -1. */
  inUseIndex: number
  pinsFor: (c: StoredCredential) => number
  testingId: string | null
  usageOpen: string | null
  onReconnect?: (credentialId: string) => void
  startRename: (c: StoredCredential) => void
  move: (index: number, to: 'first' | 'down') => void
  toggle: (c: StoredCredential) => void
  test: (c: StoredCredential) => void
  toggleUsage: (c: StoredCredential) => void
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

/**
 * The one action set for an API key and a signed-in account alike: Rename,
 * Use first / Move down (the order they are tried in), Test, Reconnect,
 * Hide, and Remove or Sign out. Always visible as one button, so it works on
 * touch and from the keyboard.
 */
function ManageMenu({ c, index, ctx }: { c: StoredCredential; index: number; ctx: RowContext }) {
  const { count, busy, onReconnect, provider } = ctx
  const isOauth = ctx.noun === 'account'
  const canTest = !c.disabled && c.status !== 'needs_reconnect' && ctx.testingId === null
  const canShowUsage = !isOauth && supportsCredentialUsage(provider) && count > 1 && c.status !== 'needs_reconnect' && !c.disabled
  const items: ReactNode[] = [
    <DropdownItem key="rename" onSelect={() => ctx.startRename(c)}>Rename</DropdownItem>,
    count > 1 ? (
      <DropdownItem key="first" disabled={index === 0 || busy} onSelect={() => ctx.move(index, 'first')}>Use first</DropdownItem>
    ) : null,
    count > 1 ? (
      <DropdownItem key="down" disabled={index === count - 1 || busy} onSelect={() => ctx.move(index, 'down')}>Move down</DropdownItem>
    ) : null,
    <DropdownItem key="test" disabled={!canTest} onSelect={() => ctx.test(c)}>Test</DropdownItem>,
    onReconnect ? <DropdownItem key="reconnect" onSelect={() => onReconnect(c.id)}>Reconnect</DropdownItem> : null,
    canShowUsage ? (
      <DropdownItem key="usage" onSelect={() => ctx.toggleUsage(c)}>
        {ctx.usageOpen === c.id ? 'Close usage' : 'Show usage'}
      </DropdownItem>
    ) : null,
    <DropdownItem key="toggle" onSelect={() => ctx.toggle(c)}>{c.disabled ? 'Show' : 'Hide'}</DropdownItem>,
    <DropdownItem key="remove" className="text-(--color-error)" onSelect={() => ctx.askRemove(c.id)}>
      {isOauth ? 'Sign out…' : 'Remove…'}
    </DropdownItem>,
  ].filter(Boolean)
  return (
    <Dropdown
      aria-label={`More actions for ${c.label || c.id}`}
      trigger={<MoreHorizontal size={14} aria-hidden="true" />}
      align="end"
      className="h-7 min-w-0 gap-1 bg-transparent px-1.5 text-(--color-text-muted) hover:bg-(--bg-key) hover:text-(--color-text)"
    >
      {items}
    </Dropdown>
  )
}

/**
 * One row for every stored credential: its position in the order, name, what
 * kind it is, its status in words, then a caption that says what the status
 * means. Usage (`refresh`, `body`) comes from the caller; a plain row has none.
 */
function CredentialRow({
  c,
  index,
  ctx,
  plan = null,
  refresh,
  body,
}: {
  c: StoredCredential
  index: number
  ctx: RowContext
  plan?: string | null
  refresh?: ReactNode
  body?: ReactNode
}) {
  const renamingThis = ctx.renaming?.id === c.id
  const needsReconnect = c.status === 'needs_reconnect'
  const settingsText = Object.entries(c.settings).map(([k, v]) => `${k}=${v}`).join('  ')
  const caption = ctx.testingId === c.id ? 'Checking…' : rowCaption(c, ctx, index)
  return (
    <ProfileShell
      data-credential-id={c.id}
      className={c.in_use && !ctx.envPinned && !c.disabled ? 'bg-(--accent-blue-soft)/30' : undefined}
      identity={
        renamingThis ? (
          <RenameForm c={c} ctx={ctx} />
        ) : (
          <>
            <span className="min-w-3 text-meta tabular-nums text-(--color-text-muted)">{index + 1}</span>
            <span className="text-xs font-semibold text-(--color-text)">{c.label || c.id}</span>
            <Chip>{kindLabel(c)}</Chip>
            {c.hint && <span className="font-mono text-meta text-(--color-text-muted)">{c.hint}</span>}
            {plan && <Chip>{plan}</Chip>}
            <StatusChips c={c} ctx={ctx} />
          </>
        )
      }
      actions={
        <>
          {refresh}
          {needsReconnect && ctx.onReconnect && (
            <Button type="button" size="xs" variant="primary" className="pointer-coarse:min-h-9" onClick={() => ctx.onReconnect?.(c.id)}>Reconnect</Button>
          )}
          {c.disabled && (
            <Button type="button" size="xs" variant="ghost" className="pointer-coarse:min-h-9" onClick={() => ctx.toggle(c)}>Show</Button>
          )}
          <ManageMenu c={c} index={index} ctx={ctx} />
        </>
      }
      note={
        renamingThis ? undefined : (
          <>
            {caption && <p aria-live="polite" className="mt-1 text-meta leading-relaxed text-(--color-text-muted)">{caption}</p>}
            {settingsText && <p className="mt-0.5 truncate font-mono text-meta text-(--color-text-muted)">{settingsText}</p>}
          </>
        )
      }
      body={body}
    />
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
      {({ plan, refresh, body }) => <CredentialRow c={c} index={index} ctx={ctx} plan={plan} refresh={refresh} body={body} />}
    </UsageScope>
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
  const envPinned = Boolean(provider.env_pinned)
  const perAccountUsage = isOauth && supportsCredentialUsage(provider)
  const [renaming, setRenaming] = useState<{ id: string; value: string } | null>(null)
  const [confirmRemove, setConfirmRemove] = useState<string | null>(null)
  const [usageOpen, setUsageOpen] = useState<string | null>(null)
  const [testingId, setTestingId] = useState<string | null>(null)
  const order = useOrderProviderCredentialsMutation()
  const update = useUpdateProviderCredentialMutation()
  const remove = useDeleteProviderCredentialMutation()
  const signOut = useDisconnectOauthProviderMutation()
  const push = useToastStore((s) => s.push)
  const pinned = usePinnedSessionCounts(provider.id, credentials.length > 0)

  const fail = (title: string, err: unknown) => push({ tone: 'error', title, description: errorMessage(err) })
  const noun = isOauth ? 'account' : 'key'

  const move = (index: number, to: 'first' | 'down') => {
    const ids = credentials.map((c) => c.id)
    if (to === 'first') {
      const [id] = ids.splice(index, 1)
      if (id === undefined) return
      ids.unshift(id)
    } else {
      const target = index + 1
      if (target >= ids.length) return
      ;[ids[index], ids[target]] = [ids[target], ids[index]]
    }
    const label = credentials[index]?.label
    order.mutate(
      { providerId: provider.id, ids },
      {
        onError: (err) => fail('Could not reorder', err),
        onSuccess: () => {
          if (to === 'first') push({ tone: 'success', title: `${label || 'It'} is now tried first` })
        },
      },
    )
  }

  const toggle = (c: StoredCredential) =>
    update.mutate(
      { providerId: provider.id, credentialId: c.id, body: { disabled: !c.disabled } },
      { onError: (err) => fail(c.disabled ? 'Could not show' : 'Could not hide', err) },
    )

  const test = async (c: StoredCredential) => {
    const name = c.label || c.id
    setTestingId(c.id)
    try {
      const { models } = await testCredential(provider.id, c.id)
      if (models.length > 0) {
        push({ tone: 'success', title: 'Verified', description: `${name}: ${models.length} models available.` })
      } else {
        push({ tone: 'error', title: 'Could not verify', description: `${provider.label} did not accept ${name}.` })
      }
    } catch (err) {
      fail('Could not verify', err)
    } finally {
      setTestingId(null)
    }
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
      push({ tone: 'success', title: isOauth ? 'Signed out' : 'Key removed', description: c.label })
    } catch (err) {
      fail(isOauth ? 'Could not sign out' : 'Could not remove key', err)
    }
  }

  if (credentials.length === 0 && !envPinned) return null

  const ctx: RowContext = {
    provider,
    count: credentials.length,
    envPinned,
    noun,
    busy: order.isPending,
    inUseIndex: credentials.findIndex((c) => c.in_use && !c.disabled),
    pinsFor: (c) => c.pinned_sessions ?? pinned[c.id] ?? 0,
    testingId,
    usageOpen,
    onReconnect,
    startRename: (c) => setRenaming({ id: c.id, value: c.label }),
    move,
    toggle,
    test: (c) => { void test(c) },
    toggleUsage: (c) => setUsageOpen(usageOpen === c.id ? null : c.id),
    askRemove: setConfirmRemove,
    renaming,
    setRenaming,
    saveRename,
  }

  // Only a list with several entries has an order worth naming; while an
  // exported key is in force the stored ones are not tried at all.
  const showOrder = !envPinned && credentials.length > 1

  return (
    <div className="space-y-2">
      {showOrder && (
        <div>
          <h4 className="text-xs font-semibold text-(--color-text)">Tried in this order</h4>
          <p className="text-meta leading-relaxed text-(--color-text-muted)">
            When one {noun} hits its limit, the next one is used.
          </p>
        </div>
      )}
      <div className={LIST_CLASS} role="list" aria-label={`${provider.label} ${noun}s`}>
        {envPinned && (
          <div role="listitem" className={`${ROW_BORDER} bg-(--accent-blue-soft)/40 px-3 py-3`}>
            {isOauth && perAccountUsage ? (
              // The exported credential has its own usage, read without an account id.
              <UsageScope providerId={provider.id} providerLabel={provider.label} label="From environment" emptyText="No usage details reported.">
                {({ plan, refresh, body }) => (
                  <div className="space-y-3">
                    <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1.5">
                      <div className="flex min-w-0 flex-1 basis-48 flex-wrap items-center gap-x-2 gap-y-1">
                        <span className="text-xs font-semibold text-(--color-text)">From environment</span>
                        {provider.env_var && <span className="font-mono text-meta text-(--color-text-muted)">{provider.env_var}</span>}
                        {plan && <Chip>{plan}</Chip>}
                        <Chip tone="info">In use</Chip>
                        <Chip>Read-only</Chip>
                      </div>
                      <div className="flex shrink-0 items-center gap-1">{refresh}</div>
                    </div>
                    <p className="text-meta leading-relaxed text-(--color-text-muted)">
                      Set in the environment when OpenAgentd started. Stored {noun}s are on standby while it is set.
                    </p>
                    {body}
                  </div>
                )}
              </UsageScope>
            ) : (
              <div className="grid grid-cols-[24px_minmax(0,1fr)] gap-2.5">
                <span className="flex h-6 items-center justify-center rounded-sm bg-(--bg-key) text-meta font-semibold text-(--color-text-muted)">env</span>
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className="text-xs font-semibold text-(--color-text)">From environment</span>
                    {provider.env_var && <span className="font-mono text-meta text-(--color-text-muted)">{provider.env_var}</span>}
                    <Chip tone="info">In use</Chip>
                    <Chip>Read-only</Chip>
                  </div>
                  <p className="mt-0.5 text-meta leading-relaxed text-(--color-text-muted)">
                    Set in the environment when OpenAgentd started. Stored {noun}s are on standby while it is set.
                  </p>
                </div>
              </div>
            )}
          </div>
        )}
        {credentials.map((c, i) => {
          // "Hidden" is not "signed out": only a hidden or signed-out account skips usage.
          const usageActive = isOauth && perAccountUsage && supportsUsage(provider) && !c.disabled && c.status !== 'disabled' && c.status !== 'needs_reconnect'
          if (usageActive) return <ActiveOAuthRow key={c.id} c={c} index={i} ctx={ctx} />
          return (
            <CredentialRow
              key={c.id}
              c={c}
              index={i}
              ctx={ctx}
              body={usageOpen === c.id ? <KeyUsage providerId={provider.id} providerLabel={provider.label} credentialId={c.id} label={c.label || c.id} /> : undefined}
            />
          )
        })}
        {(() => {
          const target = credentials.find((c) => c.id === confirmRemove)
          return (
            <ConfirmDialog
              open={target !== undefined}
              onOpenChange={(open) => { if (!open) setConfirmRemove(null) }}
              title={isOauth ? `Sign out of “${target?.label ?? ''}”?` : `Remove the key “${target?.label ?? ''}”?`}
              description={isOauth
                ? 'OpenAgentd signs out of this account. Sign in again to use it.'
                : 'The key is deleted from this computer. Add it again to use it.'}
              confirmLabel={isOauth ? 'Sign out' : 'Remove'}
              onConfirm={() => (target ? doRemove(target) : undefined)}
            />
          )
        })()}
      </div>
    </div>
  )
}
