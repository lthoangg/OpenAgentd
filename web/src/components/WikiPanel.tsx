/**
 * WikiPanel — file tree + markdown editor for the agent wiki.
 *
 * The wiki lives under ``{OPENAGENTD_WIKI_DIR}`` and follows the Karpathy
 * Memory v2 layout:
 *
 *   SCHEMA.md    — Dream maintainer rules
 *   INDEX.md     — dream-maintained table of contents (editable)
 *   LOG.md       — append-only Dream activity log
 *   wiki/        — curated and source-compiled Memory v2 pages
 *   imports/     — raw imported Memory v2 documents
 *   notes/       — raw note entries (read-only in the UI; deletable)
 *
 * Legacy wiki folders (topics/entities/sources/comparisons) are still shown
 * when present for compatibility.
 *
 * `WikiTree.system` is the logical bucket for root files (USER, INDEX, LOG,
 * LINT) — there is no `system/` directory on disk.
 *
 * The panel lets the user browse the tree, open a file, and save or delete it.
 * Notes are read-only in the editor (agent-written) but can be deleted.
 * The agent also edits these files through filesystem tools during conversation;
 * invalidation is handled by the team store when any write/edit/rm tool_end
 * targets a ``wiki/`` path, and by ``useTriggerDreamMutation`` after a dream
 * run completes.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { X, Save, Trash2, FileText, Folder, Loader2, ArrowLeft, ChevronDown, ChevronRight } from 'lucide-react'
import { useIsMobile } from '@/hooks/use-mobile'
import { useModalFocus } from '@/hooks/useModalFocus'
import { useReducedMotion } from '@/hooks/useReducedMotion'
import { usePlatform } from '@/hooks/use-platform'
import { mediumHapticFeedback } from '@/lib/haptics'
import {
  useWikiTreeQuery,
  useWikiFileQuery,
  useWriteWikiFileMutation,
  useDeleteWikiFileMutation,
} from '@/queries'
import { cn } from '@/lib/utils'
import type { WikiFileInfo } from '@/api/types'

interface WikiPanelProps {
  open: boolean
  onClose: () => void
}


const WIKI_LONG_PRESS_MS = 520
const WIKI_LONG_PRESS_MOVE_TOLERANCE = 10

type SectionKey =
  | 'system'
  | 'wiki'
  | 'imports'
  | 'notes'
  | 'topics'
  | 'entities'
  | 'sources'
  | 'comparisons'

type Section = {
  key: SectionKey
  label: string
  hint: string
  files: WikiFileInfo[]
}

export function WikiPanel({ open, onClose }: WikiPanelProps) {
  const isMobile = useIsMobile()
  const prefersReducedMotion = useReducedMotion()
  const { data: tree, isLoading, isError } = useWikiTreeQuery(true)
  const [selectedPath, setSelectedPath] = useState<string | null>(null)
  const [mobilePane, setMobilePane] = useState<'tree' | 'editor'>('tree')
  useModalFocus(open, onClose)

  const handleSelect = (path: string) => {
    setSelectedPath(path)
    if (isMobile) setMobilePane('editor')
  }

  const handleBack = () => {
    setMobilePane('tree')
    setSelectedPath(null)
  }

  const rootFiles = tree?.system ?? []
  const rawSections: Section[] = [
    {
      key: 'wiki',
      label: 'wiki',
      hint: 'Curated and source-compiled Memory v2 pages',
      files: tree?.wiki ?? [],
    },
    {
      key: 'imports',
      label: 'imports',
      hint: 'Raw imported Memory v2 documents',
      files: tree?.imports ?? [],
    },
    {
      key: 'notes',
      label: 'notes',
      hint: 'Raw note entries — pending Dream synthesis',
      files: tree?.notes ?? [],
    },
    {
      key: 'topics',
      label: 'topics',
      hint: 'Legacy concept pages',
      files: tree?.topics ?? [],
    },
    {
      key: 'entities',
      label: 'entities',
      hint: 'Legacy people, tools, organisations, products',
      files: tree?.entities ?? [],
    },
    {
      key: 'sources',
      label: 'sources',
      hint: 'Legacy source summaries',
      files: tree?.sources ?? [],
    },
    {
      key: 'comparisons',
      label: 'comparisons',
      hint: 'Legacy X-vs-Y pages',
      files: tree?.comparisons ?? [],
    },
  ]
  const sections = rawSections.filter(
    (s) => s.key === 'wiki' || s.key === 'notes' || s.files.length > 0,
  )

  return (
    <AnimatePresence>
      {open && (
        <>
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.15 }}
            onClick={onClose}
            className="fixed inset-0 z-40 bg-black/40"
          />

          <motion.div
            initial={prefersReducedMotion ? { opacity: 0 } : { opacity: 0, scale: 0.97, y: 8 }}
            animate={prefersReducedMotion ? { opacity: 1 } : { opacity: 1, scale: 1, y: 0 }}
            exit={prefersReducedMotion ? { opacity: 0 } : { opacity: 0, scale: 0.97, y: 8 }}
            transition={{ duration: prefersReducedMotion ? 0.01 : 0.18, ease: [0.4, 0, 0.2, 1] }}
            className="fixed inset-x-0 bottom-0 top-[env(safe-area-inset-top,0px)] z-50 flex flex-col overflow-hidden border-(--color-border) bg-(--bg-card) shadow-2xl sm:left-1/2 sm:top-1/2 sm:inset-auto sm:h-[min(90vh,860px)] sm:w-[min(90vw,1180px)] sm:-translate-x-1/2 sm:-translate-y-1/2 sm:rounded-lg sm:border"
            role="dialog"
            aria-modal="true"
            aria-label="Wiki"
            data-modal-focus="true"
          >
            <header className="flex items-center justify-between border-b border-(--color-border) px-4 py-3">
              <div className="flex items-center gap-2">
                {isMobile && mobilePane === 'editor' && (
                  <button
                    onClick={handleBack}
                    className="rounded p-1 text-(--color-text-muted) transition-colors hover:bg-(--bg-key) hover:text-(--color-text)"
                    aria-label="Back to file list"
                  >
                    <ArrowLeft size={16} />
                  </button>
                )}
                <div>
                  <h2 className="text-sm font-semibold text-(--color-text)">Wiki</h2>
                  <p className="text-xs text-(--color-text-subtle)">
                    Agent knowledge base — synthesised from past conversations
                  </p>
                </div>
              </div>
              <button
                onClick={onClose}
                className="rounded p-1 text-(--color-text-muted) transition-colors hover:bg-(--bg-key) hover:text-(--color-text)"
                aria-label="Close wiki panel"
              >
                <X size={16} />
              </button>
            </header>

            {isMobile ? (
              <div className="flex min-h-0 flex-1 flex-col">
                {mobilePane === 'tree' ? (
                  <nav className="flex-1 overflow-y-auto px-2 py-3">
                    <TreeContent
                      isLoading={isLoading}
                      isError={isError}
                      rootFiles={rootFiles}
                      sections={sections}
                      selectedPath={selectedPath}
                      onSelect={handleSelect}
                    />
                  </nav>
                ) : (
                  <div className="min-w-0 flex-1">
                    {selectedPath ? (
                      <WikiEditor
                        key={selectedPath}
                        path={selectedPath}
                        onDeleted={handleBack}
                      />
                    ) : (
                      <EmptyState />
                    )}
                  </div>
                )}
              </div>
            ) : (
              <div className="flex min-h-0 flex-1">
                <nav className="w-[220px] shrink-0 overflow-y-auto border-r border-(--color-border) px-2 py-3">
                  <TreeContent
                    isLoading={isLoading}
                    isError={isError}
                    rootFiles={rootFiles}
                    sections={sections}
                    selectedPath={selectedPath}
                    onSelect={handleSelect}
                  />
                </nav>
                <div className="min-w-0 flex-1">
                  {selectedPath ? (
                    <WikiEditor
                      key={selectedPath}
                      path={selectedPath}
                      onDeleted={() => setSelectedPath(null)}
                    />
                  ) : (
                    <EmptyState />
                  )}
                </div>
              </div>
            )}
          </motion.div>
        </>
      )}
    </AnimatePresence>
  )
}

// ── Tree helpers ─────────────────────────────────────────────────────────────

function TreeContent({
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

  const clearLongPress = useCallback(() => {
    if (longPressTimerRef.current !== null) window.clearTimeout(longPressTimerRef.current)
    longPressTimerRef.current = null
    longPressStartRef.current = null
  }, [])

  useEffect(() => clearLongPress, [clearLongPress])

  const copyPath = async () => {
    try {
      await navigator.clipboard.writeText(file.path)
    } catch {
      // Clipboard access can fail in insecure contexts or denied WebViews.
    }
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

function WikiEditor({
  path,
  onDeleted,
}: {
  path: string
  onDeleted: () => void
}) {
  const { data: file, isLoading, isError } = useWikiFileQuery(path)
  const writeMutation = useWriteWikiFileMutation()
  const deleteMutation = useDeleteWikiFileMutation()

  const textareaRef = useRef<HTMLTextAreaElement | null>(null)
  const [dirty, setDirty] = useState(false)
  // `charCount` tracks live edits only — when null, we derive the display
  // count from `file.content.length` so an empty buffer correctly shows 0
  // (instead of incorrectly falling back to the original file length).
  const [charCount, setCharCount] = useState<number | null>(null)

  // Raw Memory v2 inputs are read-only in the editor; curated/source pages remain editable.
  const isReadOnly = path.startsWith('notes/') || path.startsWith('imports/')
  // Root files cannot be deleted — backend enforces this too.
  const isDeletable = path !== 'USER.md' && path !== 'INDEX.md' && path !== 'SCHEMA.md'

  const getDraft = (): string => textareaRef.current?.value ?? file?.content ?? ''

  const handleSave = () => {
    if (!dirty || isReadOnly) return
    writeMutation.mutate(
      { path, content: getDraft() },
      { onSuccess: () => setDirty(false) },
    )
  }

  const handleDelete = () => {
    if (!confirm(`Delete wiki file "${path}"? This cannot be undone.`)) return
    deleteMutation.mutate(path, { onSuccess: onDeleted })
  }

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (!isReadOnly && e.ctrlKey && !e.metaKey && e.key === 's') {
      e.preventDefault()
      handleSave()
    }
  }

  if (isLoading) {
    return (
      <div className="flex h-full items-center justify-center text-(--color-text-subtle)">
        <Loader2 size={16} className="animate-spin" />
      </div>
    )
  }
  if (isError || !file) {
    return (
      <div className="flex h-full items-center justify-center px-4 text-center text-xs text-(--color-error)">
        Failed to load {path}
      </div>
    )
  }

  const displayChars = charCount ?? file.content.length

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between border-b border-(--color-border) px-4 py-2">
        <div className="min-w-0 flex-1">
          <div className="truncate font-mono text-xs text-(--color-text)">{path}</div>
          {file.description && (
            <div className="truncate text-[10px] text-(--color-text-subtle)">
              {file.description}
            </div>
          )}
        </div>
        <div className="ml-2 flex items-center gap-1">
          {!isReadOnly && (
            <button
              onClick={handleSave}
              disabled={!dirty || writeMutation.isPending}
              className={cn(
                'flex items-center gap-1 rounded px-2.5 py-1 text-xs font-medium transition-colors',
                dirty
                  ? 'text-(--color-success) hover:bg-(--accent-green-soft)'
                  : 'cursor-not-allowed text-(--color-text-subtle)',
              )}
              title="Save (Ctrl+S)"
            >
              {writeMutation.isPending ? <Loader2 size={12} className="animate-spin" /> : <Save size={12} />}
              Save
            </button>
          )}
          {isDeletable && (
            <button
              onClick={handleDelete}
              disabled={deleteMutation.isPending}
              className="flex items-center gap-1 rounded px-2.5 py-1 text-xs font-medium text-(--color-error) transition-colors hover:bg-(--color-error-subtle)"
              title="Delete file"
            >
              <Trash2 size={12} />
              Delete
            </button>
          )}
        </div>
      </div>

      {writeMutation.isError && (
        <div className="border-b border-(--color-border) bg-(--color-error-subtle) px-4 py-2 text-xs text-(--color-error)">
          {(writeMutation.error as Error).message}
        </div>
      )}

      <textarea
        ref={textareaRef}
        defaultValue={file.content}
        readOnly={isReadOnly}
        onInput={(e) => {
          if (isReadOnly) return
          const v = (e.target as HTMLTextAreaElement).value
          setCharCount(v.length)
          if (!dirty) setDirty(true)
        }}
        onKeyDown={handleKeyDown}
        spellCheck={false}
        className={cn(
          'min-h-0 flex-1 resize-none p-4 font-mono text-sm text-(--color-text) focus:outline-none',
          isReadOnly
            ? 'cursor-default bg-(--bg-key) text-(--color-text-muted)'
            : 'bg-(--bg-page)',
        )}
        placeholder={
          isReadOnly ? '' :
          path === 'INDEX.md' ? '# Index\n\n- [topic](topics/topic.md) — description\n' :
          'Frontmatter recommended:\n---\ndescription: …\n---\n\n'
        }
      />

      <div className="flex items-center justify-between border-t border-(--color-border) px-4 py-1.5 text-[10px] text-(--color-text-subtle)">
        <span>{displayChars} chars</span>
        {isReadOnly ? (
          <span className="italic">read-only</span>
        ) : dirty ? (
          <span className="text-(--color-accent)">unsaved</span>
        ) : (
          <span>saved</span>
        )}
      </div>
    </div>
  )
}

// ── Empty state ──────────────────────────────────────────────────────────────

function EmptyState() {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center">
      <FileText size={24} className="text-(--color-text-subtle)" />
      <p className="text-sm text-(--color-text-2)">Select a file</p>
      <p className="max-w-xs text-xs text-(--color-text-subtle)">
        <span className="font-medium">wiki/</span> contains curated Memory v2 pages.{' '}
        <span className="font-medium">INDEX.md</span> is the dream-maintained table of contents.{' '}
        <span className="font-medium">notes/</span> and <span className="font-medium">imports/</span> are raw inputs for <code className="font-mono">Dream</code>.
      </p>
    </div>
  )
}
