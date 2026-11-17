/**
 * The connector gallery on Settings → Connectors: ready-made connectors a
 * person turns on in one click. Free ones just turn on; account ones sign
 * in at the service; key ones take a pasted key. The list comes from the
 * cloud (signed) through the server, so new ones appear without an update.
 */
import { useMemo, useRef, useState } from 'react'

import type { GalleryEntry, ServerStatus } from '@/api/client'
import { Button } from '@/components/ui/button'
import { Chip } from '@/components/ui/chip'
import { Input } from '@/components/ui/input'
import { Skeleton } from '@/components/ui/skeleton'
import { Switch } from '@/components/ui/switch'
import { McpSignInWaiting } from '@/components/settings/McpSignInWaiting'
import { TEXT } from '@/components/settings/tokens'
import { openSignInWindow, signInToMcpServer, SignInCancelled } from '@/lib/mcp-sign-in'
import { cn } from '@/lib/utils'
import {
  useConnectorGalleryQuery,
  useEnableGalleryConnectorMutation,
  useUpdateGalleryConnectorMutation,
  useUpdateMcpServerMutation,
} from '@/queries/useMcpQuery'
import { queryKeys } from '@/queries/keys'
import { useQueryClient } from '@tanstack/react-query'
import { useToastStore } from '@/stores/useToastStore'
import { errorMessage } from '@/utils/errors'

const CATEGORY_LABEL: Record<string, string> = {
  docs: 'Docs',
  search: 'Search',
  work: 'Work',
  dev: 'Dev & cloud',
  design: 'Design',
}

type Kind = 'free' | 'oauth' | 'key'

function kindOf(e: GalleryEntry): Kind {
  return e.auth === 'none' ? 'free' : e.auth === 'oauth' ? 'oauth' : 'key'
}

const SECTIONS: { kind: Kind; title: string }[] = [
  { kind: 'free', title: 'Free · just turn on' },
  { kind: 'oauth', title: 'Sign in with your account' },
  { kind: 'key', title: 'Paste a key' },
]

function monogram(name: string): string {
  const words = name.replace(/[^A-Za-z0-9 ]/g, ' ').split(/\s+/).filter(Boolean)
  return (words.length > 1 ? words[0][0] + words[1][0] : name.slice(0, 2)).toUpperCase()
}

function statusChip(entry: GalleryEntry, server: ServerStatus | null) {
  if (!server) {
    if (entry.auth === 'none') return <Chip tone="success">Free · no account</Chip>
    if (entry.auth === 'oauth') return <Chip>Sign in</Chip>
    return <Chip>Paste a key</Chip>
  }
  if (!server.enabled) return <Chip>Off</Chip>
  switch (server.state) {
    case 'ready': {
      const n = server.tool_names.length
      return <Chip tone="success">{entry.auth === 'oauth' ? 'Signed in' : `Ready · ${n} tool${n === 1 ? '' : 's'}`}</Chip>
    }
    case 'auth_required':
      return <Chip tone="warning">Needs sign-in</Chip>
    case 'starting':
      return <Chip>Starting…</Chip>
    case 'error':
      return <Chip tone="error" title={server.error ?? undefined}>Error</Chip>
    default:
      return <Chip>{server.state}</Chip>
  }
}

interface CardProps {
  entry: GalleryEntry
  onOpen: (name: string) => void
}

function ConnectorCard({ entry, onOpen }: CardProps) {
  const push = useToastStore((s) => s.push)
  const client = useQueryClient()
  const enable = useEnableGalleryConnectorMutation()
  const update = useUpdateGalleryConnectorMutation()
  const toggle = useUpdateMcpServerMutation()
  const [signingIn, setSigningIn] = useState(false)
  const [keyOpen, setKeyOpen] = useState(false)
  const [key, setKey] = useState('')
  const abort = useRef<AbortController | null>(null)
  const server = entry.server
  const busy = enable.isPending || toggle.isPending || update.isPending || signingIn

  const fail = (title: string, err: unknown) => {
    if (err instanceof SignInCancelled) return
    push({ tone: 'error', title, description: errorMessage(err) })
  }

  /** Turn it on, then sign in if the service asks. Runs from the click. */
  const connect = async () => {
    const popup = entry.auth === 'oauth' ? openSignInWindow() : null
    try {
      const st = server?.enabled ? server : await enable.mutateAsync({ id: entry.id })
      if (st.state === 'ready') {
        popup?.close()
        return
      }
      setSigningIn(true)
      abort.current = new AbortController()
      await signInToMcpServer(st.name, { popup, signal: abort.current.signal })
      push({ tone: 'success', title: `Signed in to ${entry.name}` })
    } catch (err) {
      popup?.close()
      fail(`Couldn't connect ${entry.name}`, err)
    } finally {
      setSigningIn(false)
      abort.current = null
      void client.invalidateQueries({ queryKey: queryKeys.mcp.all() })
    }
  }

  const setOn = async (on: boolean) => {
    if (on) return entry.auth === 'oauth' ? connect() : turnOn()
    if (!server?.config) return
    try {
      await toggle.mutateAsync({ name: server.name, server: { ...server.config, enabled: false } })
    } catch (err) {
      fail(`Couldn't turn off ${entry.name}`, err)
    }
  }

  const turnOn = async (withKey?: string) => {
    try {
      await enable.mutateAsync({ id: entry.id, key: withKey })
      setKeyOpen(false)
      setKey('')
    } catch (err) {
      fail(`Couldn't turn on ${entry.name}`, err)
    }
  }

  let action
  if (entry.update_for) {
    action = (
      <Button size="xs" variant="default" disabled={busy} onClick={() => update.mutateAsync(entry.id).catch((err) => fail(`Couldn't update ${entry.name}`, err))}>
        Update
      </Button>
    )
  } else if (signingIn) {
    action = null
  } else if (server?.enabled && (server.state === 'auth_required' || (entry.auth === 'oauth' && server.state !== 'ready'))) {
    // Needs sign-in, or a sign-in left open elsewhere: Connect starts a fresh one.
    action = <Button size="xs" variant="default" disabled={busy} onClick={() => void connect()}>Connect</Button>
  } else if (!server && entry.auth === 'oauth') {
    action = <Button size="xs" variant="default" disabled={busy} onClick={() => void connect()}>Connect</Button>
  } else if (!server && kindOf(entry) === 'key') {
    action = keyOpen ? null : <Button size="xs" disabled={busy} onClick={() => setKeyOpen(true)}>Set up</Button>
  } else {
    action = (
      <Switch
        aria-label={`${server?.enabled ? 'Turn off' : 'Turn on'} ${entry.name}`}
        checked={!!server?.enabled}
        disabled={busy}
        onCheckedChange={(on) => void setOn(on)}
      />
    )
  }

  return (
    <li className="flex flex-col gap-2 rounded-sm border border-(--color-border-subtle) bg-(--bg-card) p-3.5" data-connector={entry.id}>
      <div className="flex items-center gap-2.5">
        <span aria-hidden="true" className="flex size-8 shrink-0 items-center justify-center rounded-sm bg-(--bg-key) text-xs font-semibold text-(--color-text-muted)">
          {monogram(entry.name)}
        </span>
        {server ? (
          <button type="button" className={cn(TEXT.label, 'truncate text-left hover:underline')} onClick={() => onOpen(server.name)}>
            {entry.name}
          </button>
        ) : (
          <span className={cn(TEXT.label, 'truncate')}>{entry.name}</span>
        )}
      </div>
      <p className={cn(TEXT.hint, 'flex-1')}>{entry.description}</p>
      {signingIn ? (
        <McpSignInWaiting onCancel={() => abort.current?.abort()} />
      ) : keyOpen && typeof entry.auth === 'object' ? (
        <form
          className="space-y-2"
          onSubmit={(e) => {
            e.preventDefault()
            void turnOn(key.trim())
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
      ) : (
        <div className="flex min-h-7 items-center justify-between gap-2">
          {entry.update_for ? <Chip tone="warning">Update available</Chip> : statusChip(entry, server)}
          {action}
        </div>
      )}
    </li>
  )
}

export function ConnectorGallery({ onOpen }: { onOpen: (name: string) => void }) {
  const { data, isLoading, isError } = useConnectorGalleryQuery()
  const [query, setQuery] = useState('')
  const [category, setCategory] = useState<string | null>(null)

  const entries = useMemo(() => data?.entries ?? [], [data])
  const categories = useMemo(() => [...new Set(entries.map((e) => e.category))], [entries])
  const shown = useMemo(() => {
    const t = query.trim().toLowerCase()
    return entries.filter(
      (e) => (!category || e.category === category) && (!t || e.name.toLowerCase().includes(t) || e.description.toLowerCase().includes(t)),
    )
  }, [entries, query, category])

  if (isError) return null
  return (
    <section aria-labelledby="connector-gallery-title" className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <h2 id="connector-gallery-title" className={TEXT.title}>Add a connector</h2>
        <span className={TEXT.hint}>No install needed.</span>
      </div>
      <Input aria-label="Search the gallery" placeholder="Search connectors…" value={query} onChange={(e) => setQuery(e.target.value)} />
      {categories.length > 1 && (
        <div className="flex flex-wrap gap-1.5" role="group" aria-label="Category">
          {[null, ...categories].map((c) => (
            <Button key={c ?? 'all'} size="xs" variant={category === c ? 'default' : 'ghost'} aria-pressed={category === c} onClick={() => setCategory(c)}>
              {c ? (CATEGORY_LABEL[c] ?? c) : 'All'}
            </Button>
          ))}
        </div>
      )}
      {isLoading && (
        <div className="grid grid-cols-[repeat(auto-fill,minmax(15rem,1fr))] gap-2.5" role="status" aria-label="Loading the gallery">
          {[0, 1, 2].map((i) => <Skeleton key={i} className="h-28" />)}
        </div>
      )}
      {SECTIONS.map(({ kind, title }) => {
        const items = shown.filter((e) => kindOf(e) === kind)
        if (!items.length) return null
        return (
          <div key={kind} className="space-y-2">
            <h3 className={TEXT.subtle}>{title}</h3>
            <ul className="grid grid-cols-[repeat(auto-fill,minmax(15rem,1fr))] gap-2.5">
              {items.map((e) => <ConnectorCard key={e.id} entry={e} onOpen={onOpen} />)}
            </ul>
          </div>
        )
      })}
      {!isLoading && entries.length > 0 && shown.length === 0 && (
        <p className={cn(TEXT.hint, 'py-4 text-center')}>No connectors match &ldquo;{query}&rdquo;.</p>
      )}
    </section>
  )
}
