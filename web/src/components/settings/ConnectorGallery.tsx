/**
 * The connector gallery on Settings → Connectors: ready-made connectors a
 * person adds in one click, as compact tiles. Free ones turn on with a
 * switch; account ones Connect (add, then sign in at the service); key ones
 * Set up with a pasted key. The action says what each takes.
 *
 * It lists only connectors not added yet: an added one lives under
 * "Connectors", with its switch, until it is disconnected. The list comes
 * from the cloud (signed) through the server, so new ones appear without an
 * update. The page owns the search box, which filters every section.
 */
import { useMemo, useState } from 'react'

import { ApiValidationError, type GalleryEntry } from '@/api/client'
import { ConnectorIcon } from '@/components/ConnectorIcon'
import { Button } from '@/components/ui/button'
import { Callout } from '@/components/ui/callout'
import { Input } from '@/components/ui/input'
import { Skeleton } from '@/components/ui/skeleton'
import { Switch } from '@/components/ui/switch'
import { useConnectorSignIns } from '@/components/settings/connectorSignIns'
import { TEXT } from '@/components/settings/tokens'
import { openSignInWindow } from '@/lib/mcp-sign-in'
import { cn } from '@/lib/utils'
import { useConnectorGalleryQuery, useEnableGalleryConnectorMutation, useUpdateGalleryConnectorMutation } from '@/queries/useMcpQuery'
import { useToastStore } from '@/stores/useToastStore'
import { errorMessage } from '@/utils/errors'

const CATEGORY_LABEL: Record<string, string> = {
  docs: 'Docs',
  search: 'Search',
  work: 'Work',
  dev: 'Dev & cloud',
  design: 'Design',
}

/** Entries still to add: no connector at their address yet, or one on an old address to update. */
export function galleryToAdd(entries: GalleryEntry[]): GalleryEntry[] {
  return entries.filter((e) => !e.server || e.update_for)
}

export function matchesQuery(query: string, ...fields: (string | null | undefined)[]): boolean {
  const t = query.trim().toLowerCase()
  return !t || fields.some((f) => f?.toLowerCase().includes(t))
}

function ConnectorTile({ entry }: { entry: GalleryEntry }) {
  const push = useToastStore((s) => s.push)
  const signIns = useConnectorSignIns()
  const enable = useEnableGalleryConnectorMutation()
  const update = useUpdateGalleryConnectorMutation()
  const [keyOpen, setKeyOpen] = useState(false)
  const [key, setKey] = useState('')
  const busy = enable.isPending || update.isPending

  const fail = (title: string, err: unknown) => push({ tone: 'error', title, description: errorMessage(err) })

  const turnOn = async (withKey?: string) => {
    try {
      await enable.mutateAsync({ id: entry.id, key: withKey })
      push({ tone: 'success', title: `Added ${entry.name}`, description: 'It is under Connectors.' })
    } catch (err) {
      fail(`Couldn't turn on ${entry.name}`, err)
    }
  }

  // Open the sign-in window on the click, then add the connector and sign in.
  const connect = () => void signIns.run(entry.name, openSignInWindow(), () => enable.mutateAsync({ id: entry.id }))

  let action
  if (entry.update_for) {
    action = (
      <Button size="xs" variant="default" disabled={busy} onClick={() => update.mutateAsync(entry.id).catch((err) => fail(`Couldn't update ${entry.name}`, err))}>
        Update
      </Button>
    )
  } else if (entry.auth === 'none') {
    action = <Switch aria-label={`Turn on ${entry.name}`} checked={false} disabled={busy} onCheckedChange={(on) => on && void turnOn()} />
  } else if (entry.auth === 'oauth') {
    action = <Button size="xs" variant="default" disabled={busy} onClick={connect}>Connect</Button>
  } else {
    action = keyOpen ? null : <Button size="xs" disabled={busy} onClick={() => setKeyOpen(true)}>Set up</Button>
  }

  return (
    <li
      className="flex flex-wrap items-start gap-x-2.5 gap-y-2 rounded-sm border border-(--color-border-subtle) bg-(--bg-card) p-2.5"
      data-connector={entry.id}
    >
      <ConnectorIcon name={entry.name} icon={entry.icon} />
      <div className="min-w-0 flex-1">
        <span className={cn(TEXT.label, 'block truncate')}>{entry.name}</span>
        <p className={cn(TEXT.subtle, 'line-clamp-2')} title={entry.description}>
          {entry.update_for ? `A newer address for ${entry.update_for}.` : entry.description}
        </p>
      </div>
      {action && <div className="shrink-0 self-center">{action}</div>}
      {keyOpen && typeof entry.auth === 'object' && (
        <form
          className="basis-full space-y-2"
          onSubmit={(e) => {
            e.preventDefault()
            void turnOn(key.trim()).then(() => setKey(''))
          }}
        >
          <Input
            type="password"
            autoComplete="off"
            aria-label={entry.auth.key_label ?? 'Key'}
            placeholder={entry.auth.key_label ?? 'Key'}
            value={key}
            onChange={(e) => setKey(e.target.value)}
            autoFocus
          />
          <div className="flex items-center gap-2">
            <Button type="submit" size="xs" variant="default" disabled={busy || !key.trim()}>Turn on</Button>
            <Button type="button" size="xs" variant="ghost" onClick={() => setKeyOpen(false)}>Cancel</Button>
            {entry.auth.key_url && (
              <a className="ml-auto text-meta text-(--color-text-muted) underline" href={entry.auth.key_url} target="_blank" rel="noreferrer noopener">
                Get a key
              </a>
            )}
          </div>
        </form>
      )}
    </li>
  )
}

export function ConnectorGallery({ query = '' }: { query?: string }) {
  const { data, isLoading, isError, error, refetch } = useConnectorGalleryQuery()
  const [category, setCategory] = useState<string | null>(null)

  const toAdd = useMemo(() => galleryToAdd(data?.entries ?? []), [data])
  const categories = useMemo(() => [...new Set(toAdd.map((e) => e.category))], [toAdd])
  const shown = useMemo(
    () => toAdd.filter((e) => (!category || e.category === category) && matchesQuery(query, e.name, e.description)),
    [toAdd, query, category],
  )

  if (isError) {
    // A server from before the gallery answers 404: nothing to offer, nothing to report.
    if (error instanceof ApiValidationError && error.status === 404) return null
    return (
      <Callout
        tone="error"
        role="alert"
        title="Couldn't load the connector gallery"
        action={<Button size="xs" onClick={() => void refetch()}>Retry</Button>}
      >
        Your connectors and MCP servers still work. Add a server by hand under MCP servers.
      </Callout>
    )
  }
  // A search that matches nothing here leaves the section out; the page says so once.
  if (!isLoading && query.trim() && toAdd.every((e) => !matchesQuery(query, e.name, e.description))) return null
  if (!isLoading && toAdd.length === 0) return null
  return (
    <section aria-labelledby="connector-gallery-title" className="space-y-3">
      <div className="flex flex-wrap items-baseline gap-2">
        <h2 id="connector-gallery-title" className={TEXT.title}>Add a connector</h2>
        <span className={TEXT.subtle}>No install needed.</span>
      </div>
      {categories.length > 1 && (
        <div className="flex flex-wrap gap-1" role="group" aria-label="Category">
          {[null, ...categories].map((c) => (
            <Button key={c ?? 'all'} size="xs" variant={category === c ? 'default' : 'ghost'} aria-pressed={category === c} onClick={() => setCategory(c)}>
              {c ? (CATEGORY_LABEL[c] ?? c) : 'All'}
            </Button>
          ))}
        </div>
      )}
      {isLoading ? (
        <div className="grid grid-cols-[repeat(auto-fill,minmax(13rem,1fr))] gap-2" role="status" aria-label="Loading the gallery">
          {[0, 1, 2].map((i) => <Skeleton key={i} className="h-16" />)}
        </div>
      ) : shown.length > 0 ? (
        <ul className="grid grid-cols-[repeat(auto-fill,minmax(13rem,1fr))] gap-2">
          {shown.map((e) => <ConnectorTile key={e.id} entry={e} />)}
        </ul>
      ) : (
        <p className={cn(TEXT.hint, 'py-4 text-center')}>None in this category{query.trim() ? ' match your search' : ''}.</p>
      )}
    </section>
  )
}
