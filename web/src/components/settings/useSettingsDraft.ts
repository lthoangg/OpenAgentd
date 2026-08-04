/**
 * useSettingsDraft — the single save contract for every settings page.
 *
 * Before this hook, each settings page hand-rolled its own draft state and
 * `dirty` comparison: sandbox diffed arrays index-by-index, multimodal
 * `JSON.stringify`'d two normalized objects, title-generation compared three
 * fields by hand, terminal tracked an ad-hoc `saved` boolean, and
 * notifications skipped the concept entirely by writing on every keystroke.
 * Four contracts meant a user could not predict whether an edit had stuck.
 *
 * The rebase rule: a draft follows the server snapshot until the user edits
 * it. We detect a new snapshot by *identity*, not by value, so refetching
 * equal data never clobbers in-progress edits.
 *
 * Usage:
 *   const draft = useSettingsDraft({
 *     data,
 *     initial: DEFAULT_FORM,
 *     normalize,
 *     onSave: (value) => updateMut.mutateAsync(value),
 *     successTitle: 'Terminal settings saved',
 *   })
 *   draft.patch({ enabled: true })
 *   <SettingsPage draft={draft}>…</SettingsPage>
 */
import { useCallback, useMemo, useState } from 'react'

import { useToastStore } from '@/stores/useToastStore'

interface UseSettingsDraftOptions<T> {
  /** Latest server snapshot. `undefined` while the query is loading. */
  data: T | undefined
  /** Draft value used before the first snapshot arrives. */
  initial: T
  /** Persists the normalized draft and returns the saved snapshot. */
  onSave: (value: T) => Promise<T>
  /**
   * Canonicalizes a value before both the dirty-compare and the save call.
   * Without this, cosmetic differences (untrimmed strings, `undefined` vs
   * missing keys) register as unsaved changes.
   */
  normalize?: (value: T) => T
  /** Maps a raw server snapshot into draft shape, e.g. merging defaults. */
  hydrate?: (data: T) => T
  /** Toast title shown after a successful save. */
  successTitle: string
}

/**
 * The value-independent half of a draft: everything the save bar needs.
 * Split out so `SettingsPage` and `combineDrafts` can accept drafts of any
 * value type without generic variance fights or casts.
 */
export interface DraftControls {
  /** True when the draft differs from the last saved snapshot. */
  dirty: boolean
  /** True when Save should be enabled. */
  canSave: boolean
  /** True while the save request is in flight. */
  isSaving: boolean
  /** Persists the draft; surfaces success/failure as a toast. */
  save: () => Promise<void>
  /** Discards edits and returns to the last saved snapshot. */
  reset: () => void
}

export interface SettingsDraft<T> extends DraftControls {
  /** Current working value. */
  value: T
  /** Replaces the whole draft. */
  set: (next: T | ((prev: T) => T)) => void
  /** Shallow-merges a partial into the draft. */
  patch: (partial: Partial<T>) => void
}

export function useSettingsDraft<T>({
  data,
  initial,
  onSave,
  normalize,
  hydrate,
  successTitle,
}: UseSettingsDraftOptions<T>): SettingsDraft<T> {
  const push = useToastStore((s) => s.push)
  const [isSaving, setIsSaving] = useState(false)

  // `source` is the snapshot the draft is based on. Keeping it in the same
  // state object as `value` makes the rebase a single atomic update. `sourceKey`
  // is the serialized form used for change detection.
  const [state, setState] = useState<{
    source: T | undefined
    sourceKey: string | undefined
    value: T
  }>({ source: undefined, sourceKey: undefined, value: initial })

  // Rebase onto a new server snapshot. Compared by serialized *value* rather
  // than object reference: callers frequently derive the snapshot inline
  // (`data ? {...data} : undefined`), which produces a new reference on every
  // render. An identity check would then rebase continuously and discard edits
  // mid-typing, so value comparison is what makes this hook safe to call
  // without memoizing the input.
  const dataKey = data === undefined ? undefined : JSON.stringify(data)
  if (data !== undefined && dataKey !== state.sourceKey) {
    setState({
      source: data,
      sourceKey: dataKey,
      value: hydrate ? hydrate(data) : data,
    })
  }

  const canon = useCallback(
    (value: T) => (normalize ? normalize(value) : value),
    [normalize],
  )

  const dirty = useMemo(() => {
    if (state.source === undefined) return false
    const base = hydrate ? hydrate(state.source) : state.source
    return JSON.stringify(canon(state.value)) !== JSON.stringify(canon(base))
  }, [state.source, state.value, canon, hydrate])

  const set = useCallback((next: T | ((prev: T) => T)) => {
    setState((prev) => ({
      ...prev,
      value: typeof next === 'function' ? (next as (p: T) => T)(prev.value) : next,
    }))
  }, [])

  const patch = useCallback(
    (partial: Partial<T>) => set((prev) => ({ ...prev, ...partial })),
    [set],
  )

  const reset = useCallback(() => {
    setState((prev) => ({
      ...prev,
      value: prev.source === undefined
        ? initial
        : hydrate
          ? hydrate(prev.source)
          : prev.source,
    }))
  }, [initial, hydrate])

  const save = useCallback(async () => {
    setIsSaving(true)
    try {
      const saved = await onSave(canon(state.value))
      // Adopt the server's echo as the new baseline so the page reflects any
      // server-side coercion (clamped numbers, dropped empty keys).
      setState({
        source: saved,
        sourceKey: JSON.stringify(saved),
        value: hydrate ? hydrate(saved) : saved,
      })
      push({ tone: 'success', title: successTitle })
    } catch (err) {
      push({
        tone: 'error',
        title: 'Save failed',
        description: err instanceof Error ? err.message : String(err),
      })
    } finally {
      setIsSaving(false)
    }
  }, [onSave, canon, state.value, hydrate, push, successTitle])

  return {
    value: state.value,
    set,
    patch,
    dirty,
    // Callers that need validation gating narrow this further; see the
    // Automation page, where the errors derive from the draft value itself.
    canSave: dirty && !isSaving,
    isSaving,
    save,
    reset,
  }
}

/**
 * Presents several independent drafts as one, so a page that groups multiple
 * settings resources (Automation: titles + summarization + multimodal) can
 * share a single save bar.
 *
 * Only the groups the user actually edited are saved, which keeps a validation
 * error in an untouched group from blocking an unrelated edit.
 *
 * Returns only the save-bar controls; read and write values through the
 * individual drafts.
 */
export function combineDrafts(drafts: readonly DraftControls[]): DraftControls {
  const editable = drafts.filter((d) => d.dirty)
  return {
    dirty: editable.length > 0,
    // Every group with pending edits must be individually savable.
    canSave: editable.length > 0 && editable.every((d) => d.canSave),
    isSaving: drafts.some((d) => d.isSaving),
    save: async () => {
      await Promise.all(editable.map((d) => d.save()))
    },
    reset: () => drafts.forEach((d) => d.reset()),
  }
}
