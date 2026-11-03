/**
 * RunPicker — how the next message runs: model, thinking level, account.
 *
 * One surface for all three, opened from the run chip under the composer
 * (⌘., ``/model``, ``/think``, or the palette). Every pick is saved on the
 * session at once; a refused save puts the previous choice back and says so.
 *
 * Keyboard: type to search models, ↑/↓ to move, Enter to pick and close;
 * with the search empty, ←/→ step the thinking level. Focus stays in the
 * search while rows are clicked, so the keys keep working after a mouse pick.
 * A search matches loosely and ranks the closest model first (fuzzysort, as
 * the palette and Settings' model field do), in one list.
 */
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import fuzzysort from 'fuzzysort'
import { Check, RotateCcw, Search } from 'lucide-react'

import type { StoredCredential } from '@/api/client'
import { getAgent, getCodeAgent } from '@/api/client'
import { Button } from '@/components/ui/button'
import { Chip } from '@/components/ui/chip'
import { MENU_ITEM_CLASS } from '@/components/ui/menu-styles'
import { MODEL_LINE_CLASS, ModelPart, PROVIDER_PART_CLASS } from '@/components/ui/model-name'
import { SegmentedControl } from '@/components/ui/segmented-control'
import { hoverIntent } from '@/hooks/use-hover-intent'
import { useProviderUsageQuery } from '@/queries/useProvidersQuery'
import { useUpdateAgentMutation } from '@/queries/useAgentSettingsQueries'
import { selectionHapticFeedback } from '@/lib/haptics'
import {
  loadRecentModels,
  quotaSummary,
  rememberRecentModel,
  setFrontmatterScalars,
  splitModelId,
  stepThinkingLevel,
  thinkingLevelLabel,
  thinkingLevelShortLabel,
} from '@/lib/run-settings'
import { cn } from '@/lib/utils'
import { useAgentStore } from '@/stores/useAgentStore'
import { useSettingsStore } from '@/stores/useSettingsStore'
import type { RunPickerFocus } from '@/stores/useUIStore'
import { useToastStore } from '@/stores/useToastStore'
import type { RunSettings } from './useRunSettings'

const MAX_LISTED = 60

interface ModelRow {
  id: string
  /** The heading the row sits under; ``null`` in ranked search results. */
  group: 'Recent' | string | null
}

function rowsFor(settings: RunSettings, query: string, recent: string[]): ModelRow[] {
  const ids = settings.models.map((m) => m.id)
  // A saved model the registry no longer lists still shows, so the list
  // never misreports what is running.
  if (settings.model && !ids.includes(settings.model)) ids.unshift(settings.model)
  const q = query.trim()
  if (q) {
    // Ranked, so headings would repeat; each row names its provider anyway.
    return fuzzysort
      .go(q, ids, { threshold: 0.2, limit: MAX_LISTED })
      .map((result) => ({ id: result.target, group: null }))
  }
  const recentRows = recent.filter((id) => ids.includes(id)).map((id) => ({ id, group: 'Recent' }))
  const rest = ids
    .filter((id) => !recent.includes(id))
    .map((id) => ({ id, group: splitModelId(id).provider || 'Models' }))
  return [...recentRows, ...rest]
}

export interface RunPickerProps {
  settings: RunSettings
  focus: RunPickerFocus
  /** Closes the picker (Enter on a model, or after Make default). */
  onDone: () => void
  /** Phone sheet: taller rows. */
  touch?: boolean
}

export function RunPicker({ settings, focus, onDone, touch = false }: RunPickerProps) {
  const setRun = useAgentStore((s) => s.setSessionRunSettings)
  const pushToast = useToastStore((s) => s.push)
  const [query, setQuery] = useState('')
  // Read once per opening: a pick is remembered for next time, but the list
  // does not reorder under the pointer while it is open.
  const [recent] = useState(loadRecentModels)
  const rows = useMemo(() => rowsFor(settings, query, recent), [settings, query, recent])
  // The list opens on the model that runs, as a native pop-up menu opens on
  // its checked item; a search, or the user moving, takes over from there. The
  // highlight follows a model, not a position, so a list that changes (the
  // registry arriving) keeps it on the same row.
  const runningRow = query === '' ? Math.max(0, rows.findIndex((row) => row.id === settings.model)) : 0
  const [movedTo, setMovedTo] = useState<string | null>(null)
  const movedRow = movedTo === null ? -1 : rows.findIndex((row) => row.id === movedTo)
  const active = movedRow >= 0 ? movedRow : runningRow
  const setActive = (index: number | null) => setMovedTo(index === null ? null : rows[index]?.id ?? null)
  const searchRef = useRef<HTMLInputElement>(null)
  const thinkingRef = useRef<HTMLDivElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  // The picker opens upward from the chip: while a search narrows the list
  // it keeps the height it had, so the search field stays where the typing is.
  const [searchHeight, setSearchHeight] = useState<number | null>(null)
  const changeQuery = (value: string) => {
    if (value === '') setSearchHeight(null)
    else if (query === '') setSearchHeight(listRef.current?.getBoundingClientRect().height ?? null)
    setQuery(value)
    // A new search starts on its best match (an empty one on the running
    // model). Not ``setActive(0)``: that names the first row of the list
    // before this key, and would hold the highlight on it.
    setActive(null)
  }

  // Where focus starts: the search, or the chosen thinking level. The
  // running model scrolls into view either way.
  useEffect(() => {
    const id = requestAnimationFrame(() => {
      listRef.current?.querySelector<HTMLElement>('[aria-selected="true"]')?.scrollIntoView?.({ block: 'nearest' })
      if (focus === 'thinking') {
        thinkingRef.current?.querySelector<HTMLButtonElement>('[aria-checked="true"], [role="radio"]')?.focus()
      } else if (!touch) {
        // Touch: focusing the search would raise the keyboard over the list.
        searchRef.current?.focus()
      }
    })
    return () => cancelAnimationFrame(id)
  }, [focus, touch])

  // A failed save puts the previous choice back and says so in a toast with
  // Retry (setSessionRunSettings).
  const save = (patch: Parameters<typeof setRun>[0]) => setRun(patch)

  const pickModel = (id: string, close: boolean) => {
    selectionHapticFeedback()
    rememberRecentModel(id)
    const next = settings.models.find((m) => m.id === id)
    const levels = next?.thinking_levels.filter((l) => l !== '__none__') ?? []
    // While the list is the placeholder its rows carry no levels, so the
    // level stays as it is rather than being dropped.
    const supported = settings.modelsLoading || levels.includes(settings.thinkingLevel ?? '')
    let keepLevel = settings.thinkingLevel && supported ? settings.thinkingLevel : null
    const toAgentModel = id === settings.agentModel
    // Back on the agent's model its own level applies again: pinning the same
    // value would only mark the session as changed.
    if (toAgentModel && keepLevel === settings.agentThinkingLevel) keepLevel = null
    const sameProvider = splitModelId(id).provider === settings.provider
    void save({
      model: toAgentModel ? null : id,
      thinkingLevel: keepLevel,
      // An account belongs to one provider; another provider starts on Auto.
      ...(sameProvider ? {} : { credentialId: null }),
    })
    if (close) onDone()
  }

  const pickLevel = (level: string) => {
    void save({ thinkingLevel: level })
  }

  const pickAccount = (id: string | null) => {
    selectionHapticFeedback()
    void save({ credentialId: id })
  }

  const reset = () => {
    void save({ model: null, thinkingLevel: null, credentialId: null })
  }

  const updateAgent = useUpdateAgentMutation(settings.agentName ?? 'code')
  const makeDefault = async () => {
    const name = settings.agentName ?? 'code'
    try {
      const detail = name === 'code' ? await getCodeAgent() : await getAgent(name)
      const content = setFrontmatterScalars(detail.content, {
        model: settings.model,
        thinking_level: settings.thinkingLevel,
      })
      await updateAgent.mutateAsync({ content })
      // The session no longer differs from its agent.
      await setRun({ model: null, thinkingLevel: null })
      pushToast({ tone: 'success', title: 'Default saved', description: `New sessions run ${settings.model}${settings.thinkingLevel ? ` · ${thinkingLevelLabel(settings.thinkingLevel)}` : ''}.` })
      onDone()
    } catch (err) {
      pushToast({
        tone: 'error',
        title: "Couldn't save the default",
        description: err instanceof Error ? err.message : String(err),
        action: { label: 'Retry', onAction: () => void makeDefault() },
      })
    }
  }

  const onSearchKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      const count = rows.length
      if (count === 0) return
      const next = (active + (event.key === 'ArrowDown' ? 1 : -1) + count) % count
      setActive(next)
      listRef.current?.querySelector(`[data-row="${next}"]`)?.scrollIntoView({ block: 'nearest' })
      return
    }
    if (event.key === 'Enter') {
      event.preventDefault()
      const row = rows[active]
      if (row) pickModel(row.id, true)
      return
    }
    if ((event.key === 'ArrowLeft' || event.key === 'ArrowRight') && query === '' && settings.thinkingLevels.length > 0) {
      event.preventDefault()
      const next = stepThinkingLevel(settings.thinkingLevels, settings.thinkingLevel, event.key === 'ArrowRight' ? 1 : -1)
      if (next && next !== settings.thinkingLevel) pickLevel(next)
    }
  }

  const atDefaults = !settings.customized
  const rowClass = cn(MENU_ITEM_CLASS, touch && 'min-h-11 text-sm')

  return (
    <div className="flex min-h-0 flex-col" data-run-picker="">
      {/* Borderless, over a hairline, like the palette and the other pickers. */}
      <div className="flex items-center gap-1.5 border-b border-(--color-border-subtle) px-2 pb-1.5">
        <Search size={13} aria-hidden="true" className="shrink-0 text-(--color-text-muted)" />
        <input
          ref={searchRef}
          type="search"
          value={query}
          onChange={(e) => changeQuery(e.target.value)}
          onKeyDown={onSearchKeyDown}
          placeholder="Search models…"
          aria-label="Search models"
          aria-controls="run-picker-models"
          aria-activedescendant={rows[active] ? `run-picker-model-${active}` : undefined}
          autoComplete="off"
          spellCheck={false}
          className={cn(
            'min-w-0 flex-1 bg-transparent text-(--color-text) placeholder-(--color-text-muted) outline-none',
            // 16px on touch so iOS does not zoom the page.
            touch ? 'h-11 text-base' : 'h-7 text-sm',
          )}
        />
      </div>

      <div
        ref={listRef}
        id="run-picker-models"
        role="listbox"
        aria-label="Models"
        className={cn('overflow-y-auto overscroll-contain px-1 pt-1', touch ? 'max-h-[40dvh]' : 'max-h-60')}
        style={searchHeight ? { minHeight: searchHeight } : undefined}
      >
        {settings.modelsLoading && rows.length === 0 ? (
          <p className="px-2 py-3 text-xs text-(--color-text-muted)" role="status">Loading models…</p>
        ) : rows.length === 0 ? (
          <p className="px-2 py-3 text-xs text-(--color-text-muted)">No model matches “{query}”.</p>
        ) : rows.map((row, index) => {
          const header = row.group !== null && (index === 0 || rows[index - 1].group !== row.group)
          const { provider, model } = splitModelId(row.id)
          const selected = row.id === settings.model
          return (
            <div key={`${row.group}:${row.id}`}>
              {header && <div className="px-2 pb-0.5 pt-2 text-meta font-medium text-(--color-text-muted) select-none first:pt-1">{row.group}</div>}
              <button
                type="button"
                role="option"
                id={`run-picker-model-${index}`}
                data-row={index}
                aria-selected={selected}
                data-highlighted={index === active ? '' : undefined}
                // Only a real move highlights, as in the palette: a list that
                // opens, filters or scrolls under a parked pointer does not.
                {...hoverIntent(() => { if (active !== index) setActive(index) })}
                // Keep focus in the search: WebKit would drop it on the body.
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => pickModel(row.id, false)}
                tabIndex={-1}
                className={rowClass}
              >
                {/* provider:model as everywhere (ui/model-name): the provider
                    part shows whole or drops, never as a stub like "ag…". */}
                <span className={cn('flex flex-1', MODEL_LINE_CLASS)}>
                  {provider && <span className={cn(PROVIDER_PART_CLASS, 'text-(--color-text-muted)')}>{provider}:</span>}
                  <ModelPart model={model} className="text-(--color-text)" />
                </span>
                {row.id === settings.agentModel && <span className="text-meta text-(--color-text-muted)">default</span>}
                <Check size={13} aria-hidden="true" className={selected ? 'opacity-100' : 'opacity-0'} />
              </button>
            </div>
          )
        })}
      </div>

      {settings.thinkingLevels.length > 0 && (
        <div ref={thinkingRef} className="mt-1 border-t border-(--color-border-subtle) px-2 pt-2.5">
          {/* The phone sheet stacks the label: six levels need its whole width on an iPhone mini. */}
          <div className={touch ? 'flex flex-col items-stretch gap-1.5' : 'flex items-center gap-3'}>
            <span className="shrink-0 text-xs text-(--color-text-muted)">Thinking</span>
            <SegmentedControl
              label="Thinking level"
              value={settings.thinkingLevel ?? ''}
              onChange={pickLevel}
              options={settings.thinkingLevels.map((level) => {
                const short = thinkingLevelShortLabel(level)
                const full = thinkingLevelLabel(level)
                return { value: level, label: short, ariaLabel: short === full ? undefined : full, tooltip: short === full ? undefined : full }
              })}
              size={touch ? 'default' : 'sm'}
              fill
              className="min-w-0 flex-1"
            />
          </div>
          {/* Neither the session nor the agent sets a level: no segment is
              lit, so say what happens instead of leaving it a puzzle. */}
          {!settings.thinkingLevel && (
            <p className="mt-1.5 text-meta text-(--color-text-muted)">Not set: the model's own default applies.</p>
          )}
        </div>
      )}

      {settings.accounts && settings.providerInfo && (
        <AccountList
          providerId={settings.providerInfo.id}
          providerLabel={settings.providerInfo.label}
          accounts={settings.accounts}
          usage={settings.providerInfo.supports_credential_usage === true}
          pinned={settings.credentialId}
          onPick={pickAccount}
          onReconnect={() => {
            onDone()
            useSettingsStore.getState().openSettings('providers')
          }}
          rowClass={rowClass}
        />
      )}

      <div className="mt-2 flex items-center justify-between gap-2 border-t border-(--color-border-subtle) px-1 pt-2">
        <Button type="button" variant="ghost" size="sm" onClick={reset} disabled={atDefaults}>
          <RotateCcw size={12} aria-hidden="true" />
          Reset to default
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={() => void makeDefault()}
          disabled={!settings.model || (settings.model === settings.agentModel && settings.thinkingLevel === settings.agentThinkingLevel) || updateAgent.isPending}
        >
          Make default
        </Button>
      </div>
    </div>
  )
}

function AccountList({
  providerId,
  providerLabel,
  accounts,
  usage,
  pinned,
  onPick,
  onReconnect,
  rowClass,
}: {
  providerId: string
  providerLabel: string
  accounts: StoredCredential[]
  usage: boolean
  pinned: string | null
  onPick: (id: string | null) => void
  /** Sign a signed-out account back in (Settings → Providers). */
  onReconnect: () => void
  rowClass: string
}) {
  const signedOut = accounts.filter((account) => account.status === 'needs_reconnect')
  return (
    <div role="radiogroup" aria-label={`${providerLabel} account`} className="mt-1 border-t border-(--color-border-subtle) px-1 pt-1.5">
      <div className="px-2 pb-0.5 text-meta font-medium text-(--color-text-muted) select-none">Account</div>
      <button type="button" role="radio" aria-checked={pinned === null} onClick={() => onPick(null)} className={rowClass}>
        <span className="flex-1 text-(--color-text)">Auto</span>
        <span className="text-meta text-(--color-text-muted)">next one with room</span>
        <Check size={13} aria-hidden="true" className={pinned === null ? 'opacity-100' : 'opacity-0'} />
      </button>
      {accounts.map((account) => (
        <button
          key={account.id}
          type="button"
          role="radio"
          aria-checked={pinned === account.id}
          onClick={() => onPick(account.id)}
          className={rowClass}
        >
          <span className="min-w-0 flex-1 truncate text-(--color-text)">{account.label}</span>
          <AccountState account={account} providerId={providerId} usage={usage} />
          <Check size={13} aria-hidden="true" className={pinned === account.id ? 'opacity-100' : 'opacity-0'} />
        </button>
      ))}
      {/* Beside the radios, not inside one: a radio holds no second control. */}
      {signedOut.map((account) => (
        <Button key={account.id} type="button" size="xs" variant="ghost" className="mt-0.5 ml-1" onClick={onReconnect}>
          Reconnect {account.label}…
        </Button>
      ))}
    </div>
  )
}

const QUOTA_TONE_CLASS = {
  muted: 'text-(--color-text-muted)',
  warning: 'text-(--accent-orange-text)',
  error: 'text-(--color-error)',
} as const

/** Words first: the state, then what is left of its quota (percent, spend cap or credits) when known. */
function AccountState({ account, providerId, usage }: { account: StoredCredential; providerId: string; usage: boolean }) {
  const query = useProviderUsageQuery(providerId, usage && account.status === 'ready', account.id)
  if (account.status === 'cooling_down') return <Chip tone="warning">Cooling down</Chip>
  if (account.status === 'needs_reconnect') return <Chip tone="error">Reconnect</Chip>
  const quota = quotaSummary(query.data)
  if (quota === null) return null
  const text = quota.kind === 'percent' ? [`${quota.left}% left`, quota.note].filter(Boolean).join(' · ') : quota.text
  // `title` becomes the app's tooltip (TitleTooltipLayer): the balance or cap the row has no room for,
  // and the whole phrase when it is long enough to be cut off.
  const title = [text.length > 14 ? text : null, quota.detail].filter(Boolean).join(' · ') || undefined
  return (
    <span
      title={title}
      className={cn('max-w-[11rem] min-w-0 truncate font-mono text-meta tabular-nums', QUOTA_TONE_CLASS[quota.tone])}
    >
      {text}
    </span>
  )
}
