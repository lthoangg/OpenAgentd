import { useMemo, useRef, useState } from 'react'
import fuzzysort from 'fuzzysort'
import { Check, Copy, Loader2 } from 'lucide-react'
import { SearchBar } from '@/components/ui/search-bar'
import { useIsMobile } from '@/hooks/use-mobile'
import { usePlatform } from '@/hooks/use-platform'
import { mediumHapticFeedback } from '@/lib/haptics'
import { useToastStore } from '@/stores/useToastStore'
import { MODEL_LONG_PRESS_MOVE_TOLERANCE, MODEL_LONG_PRESS_MS } from './providerUtils'

/** Indexed model entry for fuzzysort — qualifiedId is the search target
 *  *and* the value the user sees / copies, so search and display stay in
 *  sync. */
type IndexedModel = {
  modelId: string
  qualifiedId: string
}

export function ModelsPanel({
  providerId,
  models,
  visibleModels,
  search,
  onSearchChange,
  expanded,
  onToggle,
  onSaveVisibleModels,
  savingVisibleModels,
}: {
  providerId: string
  models: string[]
  visibleModels: string[]
  search: string
  onSearchChange: (v: string) => void
  expanded: boolean
  onToggle: () => void
  onSaveVisibleModels: (models: string[]) => Promise<void>
  savingVisibleModels: boolean
}) {
  // Copying is silent on success — feedback is already implicit (the
  // mouse click triggers the browser's clipboard write). We only surface
  // a toast if the clipboard API rejects, which is rare and worth
  // calling out.
  const push = useToastStore((s) => s.push)
  const visibleSet = useMemo(() => new Set(visibleModels), [visibleModels])
  const allVisible = visibleSet.size === 0

  const handleCopy = async (qualifiedId: string) => {
    try {
      await navigator.clipboard.writeText(qualifiedId)
    } catch {
      push({ tone: 'error', title: 'Copy failed', description: qualifiedId })
    }
  }

  // Materialise once per ``models`` change. Indexing into the qualified
  // string means searching for ``"openai:gpt-5"`` works just as well as
  // searching for ``"gpt5"``.
  const indexed = useMemo<IndexedModel[]>(
    () => models.map((id) => ({ modelId: id, qualifiedId: `${providerId}:${id}` })),
    [models, providerId],
  )

  // Fuzzysort: subsequence match with score-based ranking. Empty query
  // skips ranking entirely (preserves the provider's returned order).
  const visible = useMemo<IndexedModel[]>(() => {
    const q = search.trim()
    if (!q) return indexed
    const results = fuzzysort.go(q, indexed, {
      key: 'qualifiedId',
      threshold: 0.2,
      limit: 200,
    })
    return results.map((r) => r.obj)
  }, [indexed, search])
  const visibleCount = allVisible ? indexed.length : visibleSet.size

  const toggleVisibleModel = (modelId: string) => {
    const next = new Set(visibleModels)
    if (next.has(modelId)) next.delete(modelId)
    else next.add(modelId)
    void onSaveVisibleModels(Array.from(next).sort())
  }

  return (
    <div className="rounded-md border border-(--color-border) bg-(--bg-page)">
      <button
        type="button"
        onClick={onToggle}
        className="flex min-h-11 w-full items-center justify-between gap-2 px-2 py-1.5 text-left text-xs font-medium text-(--color-text-muted) hover:text-(--color-text) md:min-h-0"
        aria-expanded={expanded}
      >
        <span>
          {indexed.length} models available · {allVisible ? 'all visible' : `${visibleCount} visible`} {search && <span className="text-(--color-text-muted)">· {visible.length} shown</span>}
        </span>
        <span className="text-[11px]">{expanded ? 'Hide' : 'Show'}</span>
      </button>
      {expanded && (
        <div className="border-t border-(--color-border) p-2">
          <SearchBar
            value={search}
            onChange={(e) => onSearchChange(e.target.value)}
            placeholder="Filter models…"
          />
          <p className="mt-2 text-[11px] text-(--color-text-muted)">
            Use the visibility button next to each model to choose which models normal OpenAgentd pickers show. If none are selected, all models are visible.
          </p>
          <ul className="mt-2 max-h-64 overflow-y-auto">
            {visible.length === 0 ? (
              <li className="px-2 py-3 text-center text-xs text-(--color-text-muted)">No matching models.</li>
            ) : (
              visible.map(({ qualifiedId, modelId }) => (
                <ModelRow
                  key={qualifiedId}
                  qualifiedId={qualifiedId}
                  selected={!allVisible && visibleSet.has(modelId)}
                  savingVisibleModels={savingVisibleModels}
                  onToggleVisible={() => toggleVisibleModel(modelId)}
                  onCopy={handleCopy}
                />
              ))
            )}
          </ul>
        </div>
      )}
    </div>
  )
}

function ModelRow({
  qualifiedId,
  selected,
  savingVisibleModels,
  onToggleVisible,
  onCopy,
}: {
  qualifiedId: string
  selected: boolean
  savingVisibleModels: boolean
  onToggleVisible: () => void
  onCopy: (qualifiedId: string) => Promise<void>
}) {
  const isMobile = useIsMobile()
  const { isTauri, os } = usePlatform()
  const isTauriMobile = isTauri && (os === 'ios' || os === 'android')
  const [actionsPoint, setActionsPoint] = useState<{ x: number; y: number } | null>(null)
  const longPressTimerRef = useRef<number | null>(null)
  const longPressStartRef = useRef<{ x: number; y: number } | null>(null)

  const clearLongPress = () => {
    if (longPressTimerRef.current !== null) window.clearTimeout(longPressTimerRef.current)
    longPressTimerRef.current = null
    longPressStartRef.current = null
  }

  return (
    <li
      className="flex min-h-11 items-center gap-2 rounded px-2 py-1 hover:bg-(--bg-key) md:min-h-0"
      onContextMenu={(event) => {
        if (isTauriMobile) return
        event.preventDefault()
        setActionsPoint({ x: event.clientX, y: event.clientY })
      }}
      onPointerDown={(event) => {
        if (!isMobile || !isTauriMobile || event.pointerType === 'mouse') return
        longPressStartRef.current = { x: event.clientX, y: event.clientY }
        longPressTimerRef.current = window.setTimeout(() => {
          longPressTimerRef.current = null
          longPressStartRef.current = null
          mediumHapticFeedback()
          setActionsPoint({ x: event.clientX, y: event.clientY })
        }, MODEL_LONG_PRESS_MS)
      }}
      onPointerMove={(event) => {
        const start = longPressStartRef.current
        if (!start) return
        if (
          Math.abs(event.clientX - start.x) > MODEL_LONG_PRESS_MOVE_TOLERANCE ||
          Math.abs(event.clientY - start.y) > MODEL_LONG_PRESS_MOVE_TOLERANCE
        ) {
          clearLongPress()
        }
      }}
      onPointerUp={clearLongPress}
      onPointerCancel={clearLongPress}
      onPointerLeave={clearLongPress}
    >
      <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-(--color-text)">
        {qualifiedId}
      </span>
      <button
        type="button"
        onClick={onToggleVisible}
        disabled={savingVisibleModels}
        className={`flex h-8 min-w-16 items-center justify-center gap-1 rounded px-2 text-[11px] md:h-6 ${selected ? 'bg-(--color-success-subtle) text-(--color-success)' : 'text-(--color-text-muted) hover:bg-(--bg-card) hover:text-(--color-text)'}`}
        aria-label={`${selected ? 'Remove' : 'Show'} ${qualifiedId} in model pickers`}
        title={selected ? 'Remove from visible models' : 'Show in pickers'}
      >
        {savingVisibleModels ? <Loader2 size={12} className="animate-spin" aria-hidden="true" /> : selected ? <Check size={12} aria-hidden="true" /> : null}
        {selected ? 'Visible' : 'Show'}
      </button>
      <button
        type="button"
        onClick={() => void onCopy(qualifiedId)}
        className="flex h-8 w-8 items-center justify-center rounded text-(--color-text-muted) hover:bg-(--bg-card) hover:text-(--color-text) md:h-6 md:w-6"
        aria-label={`Copy ${qualifiedId}`}
      >
        <Copy size={13} className="md:h-[11px] md:w-[11px]" aria-hidden="true" />
      </button>
      {actionsPoint && (
        <div
          className="fixed inset-0 z-[70]"
          onClick={() => setActionsPoint(null)}
          onContextMenu={(event) => {
            event.preventDefault()
            setActionsPoint(null)
          }}
        >
          <div
            role="menu"
            aria-label={`Actions for ${qualifiedId}`}
            className="fixed min-w-44 rounded-lg border border-(--color-border) bg-(--bg-card) p-1 text-sm text-(--color-text) shadow-xl"
            style={{ left: actionsPoint.x, top: actionsPoint.y }}
            onClick={(event) => event.stopPropagation()}
          >
            <button
              type="button"
              role="menuitem"
              className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left hover:bg-(--bg-key) focus-visible:bg-(--bg-key) focus-visible:outline-none"
              onClick={() => {
                setActionsPoint(null)
                void onCopy(qualifiedId)
              }}
            >
              <Copy size={14} aria-hidden="true" />
              Copy model ID
            </button>
          </div>
        </div>
      )}
    </li>
  )
}
