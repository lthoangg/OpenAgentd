import { useRef, useState } from 'react'
import { ChevronDown, ChevronRight, FileText, Folder, Loader2 } from 'lucide-react'

import { useIsMobile } from '@/hooks/use-mobile'
import { usePlatform } from '@/hooks/use-platform'
import { mediumHapticFeedback } from '@/lib/haptics'
import type { WikiFileInfo } from '@/api/types'
import { cn } from '@/lib/utils'

const WIKI_LONG_PRESS_MS = 520
const WIKI_LONG_PRESS_MOVE_TOLERANCE = 10

export type SectionKey =
  | 'system'
  | 'wiki'
  | 'imports'
  | 'notes'
  | 'topics'
  | 'entities'
  | 'sources'
  | 'comparisons'

export type Section = {
  key: SectionKey
  label: string
  hint: string
  files: WikiFileInfo[]
}

export function TreeContent({
  isLoading,
  isError,
  rootFiles,
  sections,
  selectedPath,
  onSelect,
}: {
  isLoading: boolean
  isError: boolean
  rootFiles: WikiFileInfo[]
  sections: Section[]
  selectedPath: string | null
  onSelect: (path: string) => void
}) {
  if (isLoading) {
    return (
      <div className="px-2 py-6 text-center text-xs text-(--color-text-subtle)">
        <Loader2 size={14} className="mx-auto animate-spin" />
      </div>
    )
  }
  if (isError) {
    return <p className="px-2 py-4 text-xs text-(--color-error)">Failed to load wiki</p>
  }
  return (
    <div className="select-none py-1 font-mono text-xs">
      {rootFiles.map((file) => (
        <WikiFileRow
          key={file.path}
          file={file}
          depth={0}
          selectedPath={selectedPath}
          onSelect={onSelect}
        />
      ))}
      {sections.map((section) => (
        <WikiSection
          key={section.key}
          section={section}
          selectedPath={selectedPath}
          onSelect={onSelect}
        />
      ))}
    </div>
  )
}

function WikiSection({
  section,
  selectedPath,
  onSelect,
}: {
  section: Section
  selectedPath: string | null
  onSelect: (path: string) => void
}) {
  const [isExpanded, setIsExpanded] = useState(section.key !== 'imports')
  const childCount = section.files.length

  return (
    <div>
      <button
        type="button"
        onClick={() => setIsExpanded((value) => !value)}
        className="group flex h-7 w-full items-center gap-1.5 rounded px-1.5 text-left text-xs text-(--color-text-2) transition-colors hover:bg-(--bg-key) hover:text-(--color-text)"
        aria-expanded={isExpanded}
        title={section.hint}
      >
        {isExpanded ? (
          <ChevronDown size={13} className="shrink-0 text-(--color-text-subtle)" aria-hidden="true" />
        ) : (
          <ChevronRight size={13} className="shrink-0 text-(--color-text-subtle)" aria-hidden="true" />
        )}
        <Folder size={13} className="shrink-0 text-(--color-text-muted)" aria-hidden="true" />
        <span className="min-w-0 flex-1 truncate font-medium">{section.label}</span>
        {childCount > 0 && (
          <span className="text-[10px] text-(--color-text-subtle)">{childCount}</span>
        )}
      </button>
      {isExpanded && (
        <div className="pb-1">
          {section.files.length === 0 ? (
            <p className="h-6 truncate py-1 pl-8 pr-2 text-xs italic text-(--color-text-subtle)">empty</p>
          ) : (
            section.files.map((file) => (
              <WikiFileRow
                key={file.path}
                file={file}
                depth={1}
                selectedPath={selectedPath}
                onSelect={onSelect}
              />
            ))
          )}
        </div>
      )}
    </div>
  )
}

function WikiFileRow({
  file,
  depth,
  selectedPath,
  onSelect,
}: {
  file: WikiFileInfo
  depth: number
  selectedPath: string | null
  onSelect: (path: string) => void
}) {
  const isMobile = useIsMobile()
  const { isTauri, os } = usePlatform()
  const isTauriMobile = isTauri && (os === 'ios' || os === 'android')
  const [actionsPoint, setActionsPoint] = useState<{ x: number; y: number } | null>(null)
  const longPressTimerRef = useRef<number | null>(null)
  const longPressStartRef = useRef<{ x: number; y: number } | null>(null)
  const name = file.path.split('/').pop() ?? file.path
  const isActive = file.path === selectedPath

  const clearLongPress = () => {
    if (longPressTimerRef.current !== null) window.clearTimeout(longPressTimerRef.current)
    longPressTimerRef.current = null
    longPressStartRef.current = null
  }

  const copyPath = async () => {
    await navigator.clipboard.writeText(file.path)
  }

  return (
    <>
    <button
      type="button"
      onClick={() => onSelect(file.path)}
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
        }, WIKI_LONG_PRESS_MS)
      }}
      onPointerMove={(event) => {
        const start = longPressStartRef.current
        if (!start) return
        if (
          Math.abs(event.clientX - start.x) > WIKI_LONG_PRESS_MOVE_TOLERANCE ||
          Math.abs(event.clientY - start.y) > WIKI_LONG_PRESS_MOVE_TOLERANCE
        ) {
          clearLongPress()
        }
      }}
      onPointerUp={clearLongPress}
      onPointerCancel={clearLongPress}
      onPointerLeave={clearLongPress}
      className={cn(
        'group flex h-7 w-full items-center gap-1.5 rounded px-1.5 text-left text-xs transition-colors',
        isActive
          ? 'bg-(--bg-key) text-(--color-accent)'
          : 'text-(--color-text-2) hover:bg-(--bg-key) hover:text-(--color-text)',
      )}
      style={{ paddingLeft: `${depth * 16 + 6}px` }}
      title={file.description || file.path}
    >
      <FileText size={13} className="shrink-0 text-(--color-text-muted) group-hover:text-(--color-text-2)" aria-hidden="true" />
      <span className="min-w-0 flex-1 truncate">{name}</span>
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
          aria-label={`Actions for ${name}`}
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
              onSelect(file.path)
            }}
          >
            <FileText size={14} aria-hidden="true" />
            Open
          </button>
          <button
            type="button"
            role="menuitem"
            className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left hover:bg-(--bg-key) focus-visible:bg-(--bg-key) focus-visible:outline-none"
            onClick={() => {
              setActionsPoint(null)
              void copyPath()
            }}
          >
            <FileText size={14} aria-hidden="true" />
            Copy path
          </button>
        </div>
      </div>
    )}
    </>
  )
}

// ── Editor ───────────────────────────────────────────────────────────────────
