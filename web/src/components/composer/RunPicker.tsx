/**
 * RunPicker — how the next message runs: model, thinking level, account.
 *
 * One surface for all three, opened from the run chip under the composer
 * (⇧⌘A, ``/model``, ``/think``, or the palette). Every pick is saved on the
 * session at once; a refused save puts the previous choice back and says so.
 *
 * Keyboard: type to search models, ↑/↓ to move, Enter to pick and close;
 * with the search empty, ←/→ step the thinking level.
 */
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import { Check, RotateCcw } from 'lucide-react'

import type { StoredCredential } from '@/api/client'
import { getAgent, getCodeAgent } from '@/api/client'
import { Button } from '@/components/ui/button'
import { Chip } from '@/components/ui/chip'
import { MENU_ITEM_CLASS } from '@/components/ui/menu-styles'
import { SegmentedControl } from '@/components/ui/segmented-control'
import { useProviderUsageQuery } from '@/queries/useProvidersQuery'
import { useUpdateAgentMutation } from '@/queries/useAgentSettingsQueries'
import { selectionHapticFeedback } from '@/lib/haptics'
import {
  loadRecentModels,
  quotaLeftPercent,
  rememberRecentModel,
  setFrontmatterScalars,
  splitModelId,
  stepThinkingLevel,
  thinkingLevelLabel,
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
  group: 'Recent' | string
}

function rowsFor(settings: RunSettings, query: string, recent: string[]): ModelRow[] {
  const ids = settings.models.map((m) => m.id)
  // A saved model the registry no longer lists still shows, so the list
  // never misreports what is running.
  if (settings.model && !ids.includes(settings.model)) ids.unshift(settings.model)
  const q = query.trim().toLowerCase()
  if (q) {
    return ids
      .filter((id) => id.toLowerCase().includes(q))
      .slice(0, MAX_LISTED)
      .map((id) => ({ id, group: splitModelId(id).provider || 'Models' }))
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
  const [recent, setRecent] = useState(loadRecentModels)
  const rows = useMemo(() => rowsFor(settings, query, recent), [settings, query, recent])
  const [active, setActive] = useState(0)
  const searchRef = useRef<HTMLInputElement>(null)
  const thinkingRef = useRef<HTMLDivElement>(null)
  const listRef = useRef<HTMLDivElement>(null)

  // Where focus starts: the search, or the chosen thinking level.
  useEffect(() => {
    const id = requestAnimationFrame(() => {
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
    setRecent(rememberRecentModel(id))
    const next = settings.models.find((m) => m.id === id)
    const levels = next?.thinking_levels.filter((l) => l !== '__none__') ?? []
    const keepLevel = settings.thinkingLevel && levels.includes(settings.thinkingLevel) ? settings.thinkingLevel : null
    const sameProvider = splitModelId(id).provider === settings.provider
    void save({
      model: id === settings.agentModel ? null : id,
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
      <div className="px-1 pb-1">
        <input
          ref={searchRef}
          type="search"
          value={query}
          onChange={(e) => { setQuery(e.target.value); setActive(0) }}
          onKeyDown={onSearchKeyDown}
          placeholder="Search models…"
          aria-label="Search models"
          aria-controls="run-picker-models"
          aria-activedescendant={rows[active] ? `run-picker-model-${active}` : undefined}
          autoComplete="off"
          spellCheck={false}
          className={cn(
            'w-full rounded-sm border border-(--color-border-subtle) bg-(--bg-page) px-2 text-(--color-text) placeholder-(--color-text-muted) outline-none focus-visible:border-(--focus-ring)',
            // 16px on touch so iOS does not zoom the page.
            touch ? 'h-11 text-base' : 'h-8 text-sm',
          )}
        />
      </div>

      <div
        ref={listRef}
        id="run-picker-models"
        role="listbox"
        aria-label="Models"
        className={cn('overflow-y-auto overscroll-contain px-1', touch ? 'max-h-[40dvh]' : 'max-h-60')}
      >
        {settings.modelsLoading && rows.length === 0 ? (
          <p className="px-2 py-3 text-xs text-(--color-text-muted)" role="status">Loading models…</p>
        ) : rows.length === 0 ? (
          <p className="px-2 py-3 text-xs text-(--color-text-muted)">No model matches “{query}”.</p>
        ) : rows.map((row, index) => {
          const header = index === 0 || rows[index - 1].group !== row.group
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
                onMouseMove={() => { if (active !== index) setActive(index) }}
                onClick={() => pickModel(row.id, false)}
                tabIndex={-1}
                className={rowClass}
              >
                <span className="flex min-w-0 flex-1 font-mono">
                  {provider && <span className="min-w-0 shrink truncate text-(--color-text-muted)">{provider}:</span>}
                  <span className="min-w-0 truncate text-(--color-text)">{model}</span>
                </span>
                {row.id === settings.agentModel && <span className="text-meta text-(--color-text-muted)">default</span>}
                <Check size={13} aria-hidden="true" className={selected ? 'opacity-100' : 'opacity-0'} />
              </button>
            </div>
          )
        })}
      </div>

      {settings.thinkingLevels.length > 0 && (
        <div ref={thinkingRef} className="mt-1 flex items-center gap-3 border-t border-(--color-border-subtle) px-2 pt-2.5">
          <span className="shrink-0 text-xs text-(--color-text-muted)">Thinking</span>
          <SegmentedControl
            label="Thinking level"
            value={settings.thinkingLevel ?? ''}
            onChange={pickLevel}
            options={settings.thinkingLevels.map((level) => ({ value: level, label: thinkingLevelLabel(level) }))}
            size={touch ? 'default' : 'sm'}
            fill
            className="min-w-0 flex-1"
          />
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

/** Words first: the state, then what is left of its quota when known. */
function AccountState({ account, providerId, usage }: { account: StoredCredential; providerId: string; usage: boolean }) {
  const query = useProviderUsageQuery(providerId, usage && account.status === 'ready', account.id)
  if (account.status === 'cooling_down') return <Chip tone="warning">Cooling down</Chip>
  if (account.status === 'needs_reconnect') return <Chip tone="error">Reconnect</Chip>
  const left = quotaLeftPercent(query.data)
  return left === null ? null : <span className="font-mono text-meta tabular-nums text-(--color-text-muted)">{left}% left</span>
}
