import { useMemo, useRef, useState } from 'react'
import fuzzysort from 'fuzzysort'
import { Check, ChevronDown, Copy, Loader2 } from 'lucide-react'
import { SearchBar } from '@/components/ui/search-bar'
import { useIsMobile } from '@/hooks/use-mobile'
import { usePlatform } from '@/hooks/use-platform'
import { mediumHapticFeedback } from '@/lib/haptics'
import { useToastStore } from '@/stores/useToastStore'
import { cn } from '@/lib/utils'
import { MODEL_LONG_PRESS_MOVE_TOLERANCE, MODEL_LONG_PRESS_MS } from './providerUtils'

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

  const indexed = useMemo<IndexedModel[]>(
    () => models.map((id) => ({ modelId: id, qualifiedId: `${providerId}:${id}` })),
    [models, providerId],
  )

  const visible = useMemo<IndexedModel[]>(() => {
    const q = search.trim()
    if (!q) return indexed
    const results = fuzzysort.go(q, indexed, { key: 'qualifiedId', threshold: 0.2, limit: 200 })
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
    <div className="rounded-xs border border-(--color-border) bg-(--bg-key)/20 overflow-hidden">
      {/* Collapsed toggle row */}
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={expanded}
        className={cn(
          'flex w-full items-center justify-between gap-2 px-3 py-2 text-left',
          'text-[10.5px] text-(--color-text-muted) transition-colors',
          'hover:bg-(--bg-key)/40 hover:text-(--color-text)',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-(--focus-ring)/40',
          expanded && 'border-b border-(--color-border)',
        )}
      >
        <span className="font-mono">
          {indexed.length} models available
          {' · '}
          {allVisible ? 'all visible' : `${visibleCount} visible`}
          {search && <span className="text-(--color-text-subtle)"> · {visible.length} shown</span>}
        </span>
        <ChevronDown
          size={12}
          aria-hidden="true"
          className={cn('shrink-0 transition-transform duration-150', expanded && 'rotate-180')}
        />
      </button>

      {/* Expanded body */}
      {expanded && (
        <div className="space-y-2 p-2.5">
          <SearchBar
            value={search}
            onChange={(e) => onSearchChange(e.target.value)}
            placeholder="Filter models…"
          />

          <p className="text-[10.5px] leading-relaxed text-(--color-text-muted)">
            Use the visibility toggle to choose which models appear in pickers.
            If none are selected, all models are visible.
          </p>

          <ul className="max-h-56 overflow-y-auto -mx-0.5">
            {visible.length === 0 ? (
              <li className="px-2 py-3 text-center text-[10.5px] text-(--color-text-muted)">
                No matching models.
              </li>
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
      className="group flex min-h-9 items-center gap-1.5 rounded-xs px-2 py-1 hover:bg-(--bg-key) md:min-h-0"
      onContextMenu={(e) => {
        if (isTauriMobile) return
        e.preventDefault()
        setActionsPoint({ x: e.clientX, y: e.clientY })
      }}
      onPointerDown={(e) => {
        if (!isMobile || !isTauriMobile || e.pointerType === 'mouse') return
        longPressStartRef.current = { x: e.clientX, y: e.clientY }
        longPressTimerRef.current = window.setTimeout(() => {
          longPressTimerRef.current = null
          longPressStartRef.current = null
          mediumHapticFeedback()
          setActionsPoint({ x: e.clientX, y: e.clientY })
        }, MODEL_LONG_PRESS_MS)
      }}
      onPointerMove={(e) => {
        const start = longPressStartRef.current
        if (!start) return
        if (
          Math.abs(e.clientX - start.x) > MODEL_LONG_PRESS_MOVE_TOLERANCE ||
          Math.abs(e.clientY - start.y) > MODEL_LONG_PRESS_MOVE_TOLERANCE
        ) clearLongPress()
      }}
      onPointerUp={clearLongPress}
      onPointerCancel={clearLongPress}
      onPointerLeave={clearLongPress}
    >
      {/* Model ID */}
      <span className="min-w-0 flex-1 truncate font-mono text-[10.5px] text-(--color-text)">
        {qualifiedId}
      </span>

      {/* Visibility toggle */}
      <button
        type="button"
        onClick={onToggleVisible}
        disabled={savingVisibleModels}
        aria-label={`${selected ? 'Remove' : 'Show'} ${qualifiedId} in model pickers`}
        title={selected ? 'Remove from visible models' : 'Add to visible models'}
        className={cn(
          'flex h-6 min-w-[4rem] items-center justify-center gap-1 rounded-xs px-1.5',
          'text-[10px] font-medium transition-colors',
          selected
            ? 'bg-(--color-success-subtle) text-(--color-success) border border-(--color-success)/20'
            : 'border border-(--color-border) text-(--color-text-muted) hover:bg-(--bg-card) hover:text-(--color-text)',
          savingVisibleModels && 'opacity-50 cursor-not-allowed',
        )}
      >
        {savingVisibleModels
          ? <Loader2 size={10} className="animate-spin" aria-hidden="true" />
          : selected
            ? <Check size={10} aria-hidden="true" />
            : null}
        {selected ? 'Visible' : 'Show'}
      </button>

      {/* Copy button */}
      <button
        type="button"
        onClick={() => void onCopy(qualifiedId)}
        aria-label={`Copy ${qualifiedId}`}
        className={cn(
          'flex h-6 w-6 items-center justify-center rounded-xs',
          'border border-(--color-border) text-(--color-text-muted)',
          'transition-colors hover:bg-(--bg-card) hover:text-(--color-text)',
          'opacity-0 group-hover:opacity-100 focus-visible:opacity-100',
        )}
      >
        <Copy size={11} aria-hidden="true" />
      </button>

      {/* Context menu */}
      {actionsPoint && (
        <div
          className="fixed inset-0 z-[70]"
          onClick={() => setActionsPoint(null)}
          onContextMenu={(e) => { e.preventDefault(); setActionsPoint(null) }}
        >
          <div
            role="menu"
            aria-label={`Actions for ${qualifiedId}`}
            className="fixed min-w-40 rounded-sm border border-(--color-border) bg-(--bg-card) p-1 shadow-lg text-xs text-(--color-text)"
            style={{ left: actionsPoint.x, top: actionsPoint.y }}
            onClick={(e) => e.stopPropagation()}
          >
            <button
              type="button"
              role="menuitem"
              className="flex w-full items-center gap-2 rounded-xs px-2 py-1.5 text-left hover:bg-(--bg-key) focus-visible:bg-(--bg-key) focus-visible:outline-none"
              onClick={() => { setActionsPoint(null); void onCopy(qualifiedId) }}
            >
              <Copy size={12} aria-hidden="true" />
              Copy model ID
            </button>
          </div>
        </div>
      )}
    </li>
  )
}
