/**
 * RunPicker — how the next message runs: model, thinking level, account.
 *
 * Two pages in one surface, opened from the run chip under the composer
 * (⌘., ``/model``, ``/think``, or the palette). The first lists the models.
 * Picking one saves it and opens the second page: that model's thinking
 * levels, then its provider's accounts (``/think`` opens there directly). A
 * model with no levels and one account is picked and the picker closes.
 * Every pick is saved on the session at once; a refused save puts the
 * previous choice back and says so.
 *
 * Keyboard, as on the palette's pages: on the models, type to search, ↑/↓ to
 * move, Enter (or → at the end of the search) to pick and open the levels.
 * On the levels, ↑/↓ to move and Enter to pick and close; ← or Backspace go
 * back to the models, with the search and the highlight as they were. Focus
 * stays in the search (or the level list) while rows are clicked, so the keys
 * keep working after a mouse pick. A phone does the same with taps.
 *
 * A search matches loosely and ranks the closest model first (fuzzysort, as
 * the palette and Settings' model field do), in one list. Models sit under
 * their provider's display name ("Claude", not `anthropic`) and a row is just
 * the model. Where no heading names the provider (ranked results) its name
 * trails the row. A search still matches the whole ``provider:model`` id, so
 * ``openai:`` lists that provider's models.
 */
import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type RefObject } from 'react'
import fuzzysort from 'fuzzysort'
import { Check, ChevronLeft, ChevronRight, Search } from 'lucide-react'

import type { StoredCredential } from '@/api/client'
import { Button } from '@/components/ui/button'
import { Chip } from '@/components/ui/chip'
import { MENU_ITEM_CLASS } from '@/components/ui/menu-styles'
import { MODEL_LINE_CLASS, ModelPart } from '@/components/ui/model-name'
import { hoverIntent } from '@/hooks/use-hover-intent'
import { useProvidersQuery, useProviderUsageQuery } from '@/queries/useProvidersQuery'
import { selectionHapticFeedback } from '@/lib/haptics'
import { accountChoices, quotaSegments, splitModelId, thinkingLevelLabel } from '@/lib/run-settings'
import { pickableThinkingLevels } from '@/lib/thinking-levels'
import { cn } from '@/lib/utils'
import { useAgentStore } from '@/stores/useAgentStore'
import { useSettingsStore } from '@/stores/useSettingsStore'
import type { RunPickerFocus } from '@/stores/useUIStore'
import type { RunSettings } from './useRunSettings'

const MAX_LISTED = 60

interface ModelRow {
  id: string
  /** The heading the row sits under (a provider id); ``null`` in ranked search results. */
  group: string | null
}

function rowsFor(settings: RunSettings, query: string): ModelRow[] {
  const ids = settings.models.map((m) => m.id)
  // A saved model the registry no longer lists still shows, so the list
  // never misreports what is running.
  if (settings.model && !ids.includes(settings.model)) ids.unshift(settings.model)
  const q = query.trim()
  if (q) {
    // Ranked, so headings would repeat; each row names its provider instead.
    return fuzzysort
      .go(q, ids, { threshold: 0.2, limit: MAX_LISTED })
      .map((result) => ({ id: result.target, group: null }))
  }
  // Grouped by provider only: no Recent group on top (user request).
  return ids.map((id) => ({ id, group: splitModelId(id).provider || 'Models' }))
}

export interface RunPickerProps {
  settings: RunSettings
  /** ``thinking`` opens on the running model's levels page. */
  focus: RunPickerFocus
  /** Closes the picker (a level picked, or a model with nothing more to choose). */
  onDone: () => void
  /** Phone sheet: taller rows. */
  touch?: boolean
}

/** The "Default" level's value: no level set, the model's own applies. */
const DEFAULT_LEVEL = ''

/** The second page: a model, and the level in effect for it when the page opened. */
interface LevelsPage {
  model: string
  level: string | null
}

interface LevelOption {
  value: string
  label: string
  /** Muted text after the label: the agent's default, or what Default means. */
  note?: string
}

export function RunPicker({ settings, focus, onDone, touch = false }: RunPickerProps) {
  const setRun = useAgentStore((s) => s.setSessionRunSettings)
  const [query, setQuery] = useState('')
  const rows = useMemo(() => rowsFor(settings, query), [settings, query])
  // A provider's display name, from the providers list (its id until that loads).
  const providers = useProvidersQuery().data?.providers
  const providerLabel = (id: string) => providers?.find((p) => p.id === id)?.label ?? id

  // What a model's page offers: its levels, and its provider's accounts.
  const levelsOf = (id: string) => pickableThinkingLevels(settings.models.find((m) => m.id === id), !settings.modelsLoading)
  const accountsOf = (id: string) => {
    const { provider } = splitModelId(id)
    return provider === settings.provider ? settings.accounts : accountChoices(providers?.find((p) => p.id === provider))
  }
  const hasPage = (id: string) => levelsOf(id).length > 0 || accountsOf(id) !== null

  const [page, setPage] = useState<LevelsPage | null>(() =>
    focus === 'thinking' && settings.model && hasPage(settings.model) ? { model: settings.model, level: settings.thinkingLevel } : null,
  )
  // Page 2 keeps the height page 1 had, so the popover does not jump.
  const [pageHeight, setPageHeight] = useState<number | null>(null)

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
  const listRef = useRef<HTMLDivElement>(null)
  const levelsRef = useRef<HTMLDivElement>(null)
  const rootRef = useRef<HTMLDivElement>(null)
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

  // On each page: the highlighted model scrolls into view, and the keys go
  // to the search or the level list (an accounts-only page: the checked
  // account). Touch focuses nothing: the search would raise the keyboard.
  const onLevels = page !== null
  useEffect(() => {
    const id = requestAnimationFrame(() => {
      if (!onLevels) listRef.current?.querySelector<HTMLElement>('[data-highlighted]')?.scrollIntoView?.({ block: 'nearest' })
      if (touch) return
      if (!onLevels) {
        // Back from a page the search is a new field: the caret goes to the
        // end of the query it keeps, where → opens a page again.
        const input = searchRef.current
        input?.focus()
        input?.setSelectionRange(input.value.length, input.value.length)
      } else (levelsRef.current ?? rootRef.current?.querySelector<HTMLElement>('[data-account-list] [aria-checked="true"]'))?.focus()
    })
    return () => cancelAnimationFrame(id)
  }, [onLevels, touch])

  // A failed save puts the previous choice back and says so in a toast with
  // Retry (setSessionRunSettings).
  const save = (patch: Parameters<typeof setRun>[0]) => setRun(patch)

  const pickModel = (id: string) => {
    selectionHapticFeedback()
    const levels = levelsOf(id)
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
      // An account belongs to one provider; another provider starts on its own account in use.
      ...(sameProvider ? {} : { credentialId: null }),
    })
    if (!hasPage(id)) {
      onDone()
      return
    }
    setPageHeight(rootRef.current?.getBoundingClientRect().height ?? null)
    setPage({ model: id, level: keepLevel ?? (toAgentModel ? settings.agentThinkingLevel : null) })
  }

  const back = () => {
    if (!page) return
    // The list comes back on the model the page was for.
    setMovedTo(page.model)
    setPage(null)
    setPageHeight(null)
  }

  const pickAccount = (id: string) => {
    selectionHapticFeedback()
    void save({ credentialId: id })
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
      if (row) pickModel(row.id)
      return
    }
    if (event.key === 'ArrowRight' && !event.shiftKey && !event.altKey && !event.metaKey && !event.ctrlKey) {
      // In the search, → moves the caret until it reaches the end.
      const input = event.currentTarget
      const caretAtEnd = input.selectionStart === input.value.length && input.selectionEnd === input.value.length
      const row = rows[active]
      if (caretAtEnd && row && hasPage(row.id)) {
        event.preventDefault()
        pickModel(row.id)
      }
    }
  }

  const rowClass = cn(MENU_ITEM_CLASS, touch && 'min-h-(--phone-control) text-sm')

  if (page) {
    const levels = levelsOf(page.model)
    // The agent's own level is the default on its model; elsewhere the model decides.
    const agentDefault = page.model === settings.agentModel ? settings.agentThinkingLevel : null
    const current = settings.model === page.model ? settings.thinkingLevel : page.level
    const options: LevelOption[] = [
      ...(agentDefault ? [] : [{ value: DEFAULT_LEVEL, label: 'Default', note: "model's own level" }]),
      ...levels.map((level) => ({ value: level, label: thinkingLevelLabel(level), note: level === agentDefault ? 'default' : undefined })),
    ]
    // Accounts once the session is on this model's provider (the next render after the pick).
    const showAccounts = splitModelId(page.model).provider === settings.provider && settings.accounts && settings.providerInfo
    const pickLevel = (value: string) => {
      selectionHapticFeedback()
      // The default level is stored as none, so the session is back on its defaults.
      void save({ thinkingLevel: value === DEFAULT_LEVEL || value === agentDefault ? null : value })
      onDone()
    }
    const onPageKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
      if (event.defaultPrevented || event.shiftKey || event.altKey || event.metaKey || event.ctrlKey) return
      if (event.key === 'ArrowLeft' || event.key === 'Backspace') {
        event.preventDefault()
        back()
      }
    }
    const { model } = splitModelId(page.model)
    return (
      <div
        ref={rootRef}
        className="flex min-h-0 flex-col"
        data-run-picker=""
        data-run-picker-page="levels"
        style={pageHeight ? { minHeight: pageHeight } : undefined}
        onKeyDown={onPageKeyDown}
      >
        <div className={cn('flex items-center gap-2 border-b border-(--color-border-subtle) px-2 pb-1.5', touch ? 'min-h-(--phone-control)' : 'min-h-7 pointer-coarse:min-h-9')}>
          <button
            type="button"
            onClick={back}
            aria-label={`Back to models (${page.model})`}
            className={cn(
              'inline-flex min-w-0 items-center gap-0.5 rounded-xs bg-(--bg-key) py-0.5 pl-0.5 pr-1.5 font-medium text-(--color-text-2) transition-colors hover:text-(--color-text) focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-(--focus-ring)',
              touch ? 'min-h-8 text-sm' : 'text-meta',
            )}
          >
            <ChevronLeft size={touch ? 16 : 12} className="shrink-0" aria-hidden="true" />
            <span className={cn('flex', MODEL_LINE_CLASS)}>
              <ModelPart model={model} />
            </span>
          </button>
          <span className="ml-auto shrink-0 text-xs text-(--color-text-muted)">Thinking</span>
        </div>

        {levels.length > 0 && (
          <LevelList
            listRef={levelsRef}
            label={`Thinking for ${page.model}`}
            options={options}
            value={current ?? DEFAULT_LEVEL}
            onPick={pickLevel}
            rowClass={rowClass}
          />
        )}

        {showAccounts && (
          <AccountList
            providerId={settings.providerInfo!.id}
            providerLabel={settings.providerInfo!.label}
            accounts={settings.accounts!}
            usage={settings.providerInfo!.supports_credential_usage === true}
            locked={settings.pinnedAccount}
            inUse={settings.inUseAccount}
            onPick={pickAccount}
            onPickAndClose={(id) => {
              pickAccount(id)
              onDone()
            }}
            onReconnect={() => {
              onDone()
              useSettingsStore.getState().openSettings('models')
            }}
            rowClass={rowClass}
          />
        )}
      </div>
    )
  }

  return (
    <div ref={rootRef} className="flex min-h-0 flex-col" data-run-picker="" data-run-picker-page="models">
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
            // A touch row's height; the shell's maximum-scale=1 keeps iOS
            // from zooming on focus at the phone's 15px. A tablet's popover
            // takes the 36px touch size.
            touch ? 'h-(--phone-control) text-base' : 'h-7 text-sm pointer-coarse:h-9',
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
          <p className="px-2 py-3 text-xs text-(--color-text-muted)">No model matches "{query}".</p>
        ) : rows.map((row, index) => {
          const header = row.group !== null && (index === 0 || rows[index - 1].group !== row.group)
          const { provider, model } = splitModelId(row.id)
          const selected = row.id === settings.model
          // Under a provider's heading the row is just the model; elsewhere
          // (ranked search results) the provider's name trails it.
          const nameProvider = provider !== '' && row.group === null
          return (
            <div key={`${row.group}:${row.id}`}>
              {header && <div className="px-2 pb-0.5 pt-2 text-meta font-medium text-(--color-text-muted) select-none first:pt-1">{providerLabel(row.group!)}</div>}
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
                onClick={() => pickModel(row.id)}
                tabIndex={-1}
                className={rowClass}
              >
                <span className={cn('flex flex-1', MODEL_LINE_CLASS)}>
                  <ModelPart model={model} className="text-(--color-text)" />
                </span>
                {nameProvider && <span className="max-w-[8rem] shrink-0 truncate text-meta text-(--color-text-muted)">{providerLabel(provider)}</span>}
                {row.id === settings.agentModel && <span className="text-meta text-(--color-text-muted)">default</span>}
                <Check size={13} aria-hidden="true" className={selected ? 'opacity-100' : 'opacity-0'} />
                {/* A model with levels or accounts opens a page of its own. */}
                <ChevronRight size={13} aria-hidden="true" data-opens-page={hasPage(row.id) ? '' : undefined} className={cn('shrink-0 text-(--color-text-muted)', !hasPage(row.id) && 'opacity-0')} />
              </button>
            </div>
          )
        })}
      </div>
    </div>
  )
}

/**
 * The levels of the second page: a list driven from itself, as the models
 * are from the search. ↑/↓ move, Enter picks, a click or tap picks.
 */
function LevelList({
  listRef,
  label,
  options,
  value,
  onPick,
  rowClass,
}: {
  listRef: RefObject<HTMLDivElement | null>
  label: string
  options: LevelOption[]
  /** The level in effect (``DEFAULT_LEVEL`` for none). */
  value: string
  onPick: (value: string) => void
  rowClass: string
}) {
  // Opens on the level in effect, as the models open on the running one.
  const [active, setActive] = useState(() => Math.max(0, options.findIndex((option) => option.value === value)))
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      const count = options.length
      const next = (active + (event.key === 'ArrowDown' ? 1 : -1) + count) % count
      setActive(next)
      listRef.current?.querySelector(`[data-level-row="${next}"]`)?.scrollIntoView?.({ block: 'nearest' })
      return
    }
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault()
      const option = options[active]
      if (option) onPick(option.value)
    }
  }
  return (
    <div
      ref={listRef}
      role="listbox"
      aria-label={label}
      tabIndex={0}
      aria-activedescendant={options[active] ? `run-picker-level-${active}` : undefined}
      onKeyDown={onKeyDown}
      // The highlighted row shows where the keys go, as the search does for the models.
      data-focus-ring="off"
      className="overflow-y-auto overscroll-contain px-1 pt-1"
    >
      {options.map((option, index) => (
        <button
          key={option.value}
          type="button"
          role="option"
          id={`run-picker-level-${index}`}
          data-level-row={index}
          aria-selected={option.value === value}
          data-highlighted={index === active ? '' : undefined}
          {...hoverIntent(() => { if (active !== index) setActive(index) })}
          // Keep focus on the list, so the keys still work after a click.
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => onPick(option.value)}
          tabIndex={-1}
          className={rowClass}
        >
          <span className="min-w-0 flex-1 truncate text-(--color-text)">{option.label}</span>
          {option.note && <span className="shrink-0 text-meta text-(--color-text-muted)">{option.note}</span>}
          <Check size={13} aria-hidden="true" className={option.value === value ? 'opacity-100' : 'opacity-0'} />
        </button>
      ))}
    </div>
  )
}

function AccountList({
  providerId,
  providerLabel,
  accounts,
  usage,
  locked,
  inUse,
  onPick,
  onPickAndClose,
  onReconnect,
  rowClass,
}: {
  providerId: string
  providerLabel: string
  accounts: StoredCredential[]
  usage: boolean
  /** The account the session is locked to (starts on); `null` follows the provider's choice. */
  locked: StoredCredential | null
  /** The account the session runs on now. */
  inUse: StoredCredential | null
  onPick: (id: string) => void
  /** Enter on an account: pick it and close, as Enter on a level does. */
  onPickAndClose: (id: string) => void
  /** Sign a signed-out account back in (Settings → Models). */
  onReconnect: () => void
  rowClass: string
}) {
  const signedOut = accounts.filter((account) => account.status === 'needs_reconnect')
  // No Auto row: every session moves on when its account hits a limit. The
  // check is the session's choice (its lock, or the account in use without
  // one); "in use" marks the account it moved to when that differs.
  const checked = locked?.id ?? inUse?.id ?? null
  const movedTo = inUse && inUse.id !== checked ? inUse : null
  const onKeyDown = (id: string) => (event: KeyboardEvent<HTMLButtonElement>) => {
    if (event.key !== 'Enter') return
    event.preventDefault()
    onPickAndClose(id)
  }
  return (
    <div role="radiogroup" aria-label={`${providerLabel} account`} data-account-list="" className="mt-1 border-t border-(--color-border-subtle) px-1 pt-1.5">
      <div className="px-2 pb-0.5 text-meta font-medium text-(--color-text-muted) select-none">Account</div>
      {accounts.map((account) => (
        <button
          key={account.id}
          type="button"
          role="radio"
          aria-checked={checked === account.id}
          onClick={() => onPick(account.id)}
          onKeyDown={onKeyDown(account.id)}
          className={rowClass}
        >
          <span className="min-w-0 flex-1 truncate text-(--color-text)">{account.label}</span>
          {movedTo?.id === account.id && (
            <span data-in-use="" className="shrink-0 rounded-full border border-(--color-border) px-1.5 text-meta leading-4 text-(--color-text-2)">in use</span>
          )}
          <AccountState account={account} providerId={providerId} usage={usage} />
          <Check size={13} aria-hidden="true" className={checked === account.id ? 'opacity-100' : 'opacity-0'} />
        </button>
      ))}
      <p className="px-2 pt-0.5 pb-1 text-meta text-(--color-text-muted)">
        {movedTo && locked
          ? `Back on ${locked.label} when its limit resets.`
          : 'Starts on the checked account and moves to the next one when it hits a limit.'}
      </p>
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

/**
 * Each of the account's limits, in % used as Settings → Models shows
 * them (`5h 12% · 7d 100%`), the one it hit in red; reset times and other
 * models' limits are in the tooltip. A signed-out account says Reconnect; a
 * cooling account says so until its numbers are known.
 */
function AccountState({ account, providerId, usage }: { account: StoredCredential; providerId: string; usage: boolean }) {
  const query = useProviderUsageQuery(providerId, usage && (account.status === 'ready' || account.status === 'cooling_down'), account.id)
  if (account.status === 'needs_reconnect') return <Chip tone="error">Reconnect</Chip>
  const quota = usage ? quotaSegments(query.data) : null
  const cooling = account.status === 'cooling_down'
  if (quota === null) return cooling ? <Chip tone="warning">Cooling down</Chip> : null
  // A cooling account whose numbers show no limit hit (a short rate limit) still says it is cooling.
  const coolingNote = cooling && !quota.segments.some((s) => s.tone === 'error')
  return (
    <>
      {coolingNote && <Chip tone="warning">Cooling down</Chip>}
      {/* `title` becomes the app's tooltip (TitleTooltipLayer). */}
      <span data-account-usage="" title={quota.detail} className="max-w-[15rem] min-w-0 truncate font-mono text-meta tabular-nums text-(--color-text-muted)">
        {quota.segments.map((segment, index) => (
          <span key={index}>
            {index > 0 && <span aria-hidden="true" className="opacity-60"> · </span>}
            <span className={QUOTA_TONE_CLASS[segment.tone]}>{segment.text}</span>
          </span>
        ))}
      </span>
    </>
  )
}
