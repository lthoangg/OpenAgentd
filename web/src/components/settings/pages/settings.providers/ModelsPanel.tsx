import { useMemo, useRef, useState } from 'react'
import fuzzysort from 'fuzzysort'
import { Check, ChevronDown, Copy, Loader2 } from 'lucide-react'
import { SearchBar } from '@/components/ui/search-bar'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
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
  // Drop visibility selections for models the provider no longer lists: a
  // stale entry would whitelist nothing, hide every remaining model of the
  // provider in pickers, and leave no row behind to un-select it. The model
  // list is the single authority for which ids can be visible.
  const visibleSet = useMemo(() => {
    const inList = new Set(models)
    return new Set(visibleModels.filter((id) => inList.has(id)))
  }, [models, visibleModels])
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
    const next = new Set(visibleSet)
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
          'flex min-h-11 w-full items-center justify-between gap-2 px-3 py-2 text-left md:min-h-0',
          'text-[10.5px] text-(--color-text-muted) transition-colors',
          'hover:bg-(--bg-key)/40 hover:text-(--color-text)',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-(--focus-ring)/40',
          expanded && 'border-b border-(--color-border)',
        )}
      >
        <span className="min-w-0 flex-1 space-y-0.5 font-mono">
          <span className="block truncate text-[11px] text-(--color-text)">
            {indexed.length} models available
          </span>
          <span className="block truncate text-[10px] text-(--color-text-muted)">
            {allVisible ? 'All visible' : `${visibleCount} visible`}
            {search ? ` · ${visible.length} shown` : ''}
          </span>
        </span>
        <ChevronDown
          size={12}
          aria-hidden="true"
          className={cn('shrink-0 transition-transform duration-150', expanded && 'rotate-180')}
        />
      </button>

      {/* Expanded body */}
      {expanded && (
        <div className="space-y-2 p-2 sm:p-2.5">
          <SearchBar
            value={search}
            onChange={(e) => onSearchChange(e.target.value)}
            placeholder="Filter models…"
          />

          <p className="text-[10.5px] leading-relaxed text-(--color-text-muted)">
            Use the visibility toggle to choose which models appear in pickers.
            If none are selected, all models are visible.
          </p>

          <ul className="-mx-0.5 max-h-[45svh] overflow-y-auto md:max-h-56">
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
      className="group grid min-h-11 grid-cols-[minmax(0,1fr)_auto_auto] items-center gap-1.5 rounded-xs px-2 py-1 hover:bg-(--bg-key) md:flex md:min-h-0"
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
      <Tooltip className="min-w-0 flex-1">
        <TooltipTrigger
          className="min-w-0 flex-1"
          render={<span className="min-w-0 flex-1 truncate font-mono text-[10.5px] text-(--color-text)">{qualifiedId}</span>}
        />
        <TooltipContent>{qualifiedId}</TooltipContent>
      </Tooltip>

      {/* Visibility toggle */}
      <Tooltip>
        <TooltipTrigger
          render={
            <button
              type="button"
              onClick={onToggleVisible}
              disabled={savingVisibleModels}
              aria-label={`${selected ? 'Remove' : 'Show'} ${qualifiedId} in model pickers`}
              className={cn(
                'flex h-8 min-w-[3.5rem] items-center justify-center gap-1 rounded-xs px-2 md:h-6 md:min-w-[3.5rem] md:px-1.5',
                'text-[10px] font-medium transition-colors',
                selected
                  ? 'bg-(--color-success-subtle) text-(--color-success)'
                  : 'text-(--color-text-muted) hover:bg-(--bg-card) hover:text-(--color-text)',
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
          }
        />
        <TooltipContent>{selected ? 'Remove from visible models' : 'Add to visible models'}</TooltipContent>
      </Tooltip>

      {/* Copy button */}
      <button
        type="button"
        onClick={() => void onCopy(qualifiedId)}
        aria-label={`Copy ${qualifiedId}`}
        className={cn(
          'flex h-8 w-8 items-center justify-center rounded-xs md:h-6 md:w-6',
          'text-(--color-text-muted)',
          'transition-colors hover:bg-(--bg-card) hover:text-(--color-text)',
          'opacity-100 md:opacity-0 md:group-hover:opacity-100 md:focus-visible:opacity-100',
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
            className="fixed min-w-40 rounded-sm border border-(--color-border) bg-(--bg-card) p-1 shadow-md text-xs text-(--color-text)"
            style={{ left: actionsPoint.x, top: actionsPoint.y }}
            onClick={(e) => e.stopPropagation()}
          >
            <button
              type="button"
              role="menuitem"
              className="flex w-full items-center gap-2 rounded-xs px-2 py-1 text-left text-xs hover:bg-(--bg-key) focus-visible:bg-(--bg-key) focus-visible:outline-none"
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
