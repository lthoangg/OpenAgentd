/**
 * CommandPalette — ⌘K / Ctrl+K action search overlay.
 *
 * QuickOpen, exported below, owns the file-only ⌘P / Ctrl+P workflow. Both
 * surfaces reuse the same searchable overlay and keyboard navigation.
 * Typing ``>`` in Quick Open searches commands instead (VS Code habit), and a
 * command with a ``page`` opens a nested list in place (Switch Session…).
 * A trailing ``:line`` or ``:start-end`` (``Button.tsx:42``) searches for the
 * path and opens the pick at those lines, as VS Code's Go to File does.
 */

import { useState, useRef, useEffect, useCallback, useMemo } from 'react'
import { useDebouncedCallback } from '@tanstack/react-pacer'
import fuzzysort from 'fuzzysort'
import { Search, CornerDownLeft, ChevronLeft, ChevronRight } from 'lucide-react'
import { AppOverlay } from '@/components/ui/app-overlay'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { isImeComposing } from '@/lib/keyboard/chord'
import type { WorkspaceFileInfo } from '@/api/types'

/** Nested list a command opens in place of running. */
export interface CommandPage {
  placeholder: string
  commands: Command[]
}

export interface Command {
  id: string
  label: string
  description?: string
  shortcut?: string
  /** Optional category for grouping */
  group?: string
  /** Other words it is found by, e.g. "compact" for Reader Mode; not shown. */
  keywords?: string
  /** Opens this list inside the palette; ``action`` is not run. */
  page?: CommandPage
  action: () => void
}

const tokens = (text: string | undefined) => (text ? text.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean) : [])
const startsAWord = (words: string[], word: string) => words.some((token) => token.startsWith(word))

/**
 * How well ``cmd`` matches the query words, lower first; ``null`` when a word
 * matches nothing. The label is what the user scans and types, so it ranks
 * above everything else; keywords, group, and description only count at the
 * start of a word. Without that, "terminal" ranked Maximize Review Dock
 * (described as "…files, and terminals") above Open Terminal, simply
 * because it came first in the list.
 */
export function commandScore(cmd: Command, words: string[]): number | null {
  const label = cmd.label.toLowerCase()
  const labelWords = tokens(cmd.label)
  const keywords = tokens(cmd.keywords)
  const group = tokens(cmd.group)
  const description = tokens(cmd.description)
  let score = 0
  for (const word of words) {
    if (labelWords[0]?.startsWith(word)) score += 0
    else if (startsAWord(labelWords, word)) score += 1
    else if (label.includes(word)) score += 2
    else if (startsAWord(keywords, word)) score += 3
    else if (startsAWord(group, word)) score += 4
    else if (startsAWord(description, word)) score += 5
    else return null
  }
  return score
}

/** Matching commands, best first; ties keep their list order. */
function rankCommands(commands: Command[], query: string): Command[] {
  const words = query.split(/\s+/).filter(Boolean)
  return commands
    .map((cmd, index) => ({ cmd, index, score: commandScore(cmd, words) }))
    .filter((entry): entry is { cmd: Command; index: number; score: number } => entry.score !== null)
    .sort((a, b) => a.score - b.score || a.index - b.index)
    .map((entry) => entry.cmd)
}

// Max file rows shown in the palette — matches the old inline file-search
// dialog cap to keep the list snappy with large workspaces.
const MAX_FILE_ROWS = 30

const LINE_SUFFIX = /:(\d+)(?::\d+)?(?:[-–](\d+))?$/

/** A file query split into the path to search for and the lines to open at. */
function splitLine(query: string): { text: string; line?: number; endLine?: number } {
  const match = LINE_SUFFIX.exec(query)
  if (!match || Number(match[1]) < 1) return { text: query }
  const line = Number(match[1])
  const endLine = match[2] !== undefined && Number(match[2]) > line ? Number(match[2]) : undefined
  return { text: query.slice(0, match.index), line, endLine }
}

interface CommandPaletteProps {
  commands: Command[]
  onClose: () => void
  /** @deprecated Use QuickOpen for file search. */
  workspaceFiles?: WorkspaceFileInfo[]
  /** @deprecated Use QuickOpen for file search. */
  filesTruncated?: boolean
  /** @deprecated Use QuickOpen for file search. */
  onFileOpen?: (file: WorkspaceFileInfo) => void
}

interface PaletteOverlayProps {
  commands: Command[]
  onClose: () => void
  /** Raw workspace files (only with a workspace attached). Filtered + capped inside. */
  workspaceFiles?: WorkspaceFileInfo[]
  /**
   * The backend listing hit its own cap, so files the user knows exist may be
   * absent from ``workspaceFiles`` entirely. Say so rather than letting a
   * "my file isn't in the palette" mystery repeat.
   */
  filesTruncated?: boolean
  /** Called when the user selects a file row, with the query's ``:start-end``. */
  onFileOpen?: (file: WorkspaceFileInfo, line?: number, endLine?: number) => void
  /** Query the overlay opens with, selected so typing replaces it. */
  initialQuery?: string
}

interface QuickOpenProps {
  workspaceFiles: WorkspaceFileInfo[]
  filesTruncated?: boolean
  /** Searched instead of files while the query starts with ``>``. */
  commands?: Command[]
  /** ``line`` (and ``endLine``) are set when the query ended in ``:line`` (``:start-end``). */
  onFileOpen: (file: WorkspaceFileInfo, line?: number, endLine?: number) => void
  onClose: () => void
  /** Query to open with, e.g. a file reference that matched several files. */
  initialQuery?: string
}

export function QuickOpen({ workspaceFiles, filesTruncated = false, commands = [], onFileOpen, onClose, initialQuery }: QuickOpenProps) {
  return (
    <PaletteOverlay
      commands={commands}
      workspaceFiles={workspaceFiles}
      filesTruncated={filesTruncated}
      onFileOpen={onFileOpen}
      onClose={onClose}
      initialQuery={initialQuery}
    />
  )
}

export function CommandPalette({ commands, onClose, workspaceFiles, filesTruncated, onFileOpen }: CommandPaletteProps) {
  return <PaletteOverlay commands={commands} workspaceFiles={workspaceFiles} filesTruncated={filesTruncated} onFileOpen={onFileOpen} onClose={onClose} />
}

function PaletteOverlay({ commands, onClose, workspaceFiles = [], filesTruncated = false, onFileOpen, initialQuery = '' }: PaletteOverlayProps) {
  const [query, setQuery] = useState(initialQuery)
  const [debouncedQuery, setDebouncedQuery] = useState(initialQuery)
  const [page, setPage] = useState<{ title: string; page: CommandPage } | null>(null)
  const updateDebouncedQuery = useDebouncedCallback(
    (val: string) => setDebouncedQuery(val),
    { wait: 60, key: 'command-palette-query' },
  )

  const handleQueryChange = (val: string) => {
    setQuery(val)
    setActiveIdx(0)
    updateDebouncedQuery(val)
  }

  const [activeIdx, setActiveIdx] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  // Focus input on open, selecting a handed-in query so typing replaces it.
  useEffect(() => {
    inputRef.current?.focus()
    inputRef.current?.select()
  }, [])

  // Build the flat filtered+grouped list in one memoised pass.
  //
  // Files: ranked with fuzzysort, the same engine the `@`-mention picker and
  // the model pickers use, so `dockcom` finds `docker-compose.yml` here too.
  // `limit` caps the work inside fuzzysort rather than filtering the whole
  // workspace into an intermediate array and slicing afterwards.
  //
  // Commands: every query word must match the label, keywords, group, or
  // description (``commandScore``), so "compact mode" finds Toggle Reader
  // Mode; matches are ranked label-first and listed flat, best on top. Not
  // fuzzy — command labels are a small, curated set the user is scanning
  // visually, and fuzzy matching a 20-item list mostly surfaces surprising rows.
  // Quick Open remains a file-search surface even before an empty workspace
  // returns its first file; presence of the file callback identifies it.
  const hasFiles = Boolean(onFileOpen)
  const commandMode = page !== null || !hasFiles || query.startsWith('>')

  type FileRow = { type: 'file'; file: WorkspaceFileInfo; idx: number }
  type CmdRow  = { type: 'header'; label: string } | { type: 'cmd'; cmd: Command; idx: number }
  type Row = FileRow | CmdRow

  const { rows, totalCount, byIdx } = useMemo(() => {
    const prefixed = page === null && hasFiles && query.startsWith('>')
    const q = (prefixed ? query.slice(1) : query).trim().toLowerCase()
    const fileQ = splitLine((debouncedQuery || query).trim()).text.toLowerCase()

    // ── Commands ──────────────────────────────────────────────────────────────
    const listCommands = page ? page.page.commands : commandMode ? commands : []
    const filteredCmds = q ? rankCommands(listCommands, q) : listCommands

    // ── Files (ranked + capped) ───────────────────────────────────────────────
    let filteredFiles: WorkspaceFileInfo[] = []
    if (hasFiles && !commandMode) {
      filteredFiles = fileQ
        ? fuzzysort
            .go(fileQ, workspaceFiles, {
              key: 'path',
              limit: MAX_FILE_ROWS,
              // Matches the mention and model pickers.
              threshold: 0.2,
            })
            .map((r) => r.obj)
        : workspaceFiles.slice(0, MAX_FILE_ROWS)
    }

    // ── Build flat row list ───────────────────────────────────────────────────
    const out: Row[] = []
    let absIdx = 0

    // Commands under their group headers; a ranked search result is one list.
    const groups = new Map<string, Command[]>()
    for (const cmd of filteredCmds) {
      const g = q ? '' : cmd.group ?? ''
      if (!groups.has(g)) groups.set(g, [])
      groups.get(g)!.push(cmd)
    }
    for (const [group, cmds] of groups.entries()) {
      if (group) out.push({ type: 'header', label: group })
      for (const cmd of cmds) out.push({ type: 'cmd', cmd, idx: absIdx++ })
    }

    // Files group
    if (filteredFiles.length > 0) {
      out.push({ type: 'header', label: 'Files' })
      for (const file of filteredFiles) out.push({ type: 'file', file, idx: absIdx++ })
    }

    // Build a direct idx→row map for O(1) Enter lookup.
    const byIdx = new Map<number, FileRow | { type: 'cmd'; cmd: Command; idx: number }>()
    for (const r of out) {
      if (r.type === 'cmd' || r.type === 'file') byIdx.set(r.idx, r)
    }

    return { rows: out, totalCount: absIdx, byIdx }
  }, [commands, page, commandMode, workspaceFiles, hasFiles, query, debouncedQuery])

  // Reset active index whenever query changes.
  const [prevQuery, setPrevQuery] = useState(query)
  if (prevQuery !== query) {
    setPrevQuery(query)
    if (activeIdx !== 0) setActiveIdx(0)
  }

  // Scroll active item into view
  useEffect(() => {
    const el = listRef.current?.querySelector(`[data-idx="${activeIdx}"]`) as HTMLElement | null
    el?.scrollIntoView({ block: 'nearest' })
  }, [activeIdx])

  const showPage = useCallback((next: { title: string; page: CommandPage } | null) => {
    setPage(next)
    setQuery('')
    setDebouncedQuery('')
    setActiveIdx(0)
    inputRef.current?.focus()
  }, [])

  const runCmd = useCallback(
    (cmd: Command) => {
      if (cmd.page) {
        showPage({ title: cmd.label.replace(/…$/, ''), page: cmd.page })
        return
      }
      onClose()
      cmd.action()
    },
    [onClose, showPage],
  )

  const runFile = useCallback(
    (file: WorkspaceFileInfo) => {
      const { line, endLine } = splitLine(query.trim())
      onClose()
      onFileOpen?.(file, line, endLine)
    },
    [onClose, onFileOpen, query],
  )

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (page && (e.key === 'Escape' || (e.key === 'Backspace' && query === ''))) {
      // Claims the key from the overlay's own Escape-to-close listener.
      e.preventDefault()
      showPage(null)
      return
    }
    if (e.key === 'Escape') {
      // Handled here; the overlay layer must not close it a second time.
      e.preventDefault()
      onClose()
      return
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setActiveIdx((i) => Math.min(i + 1, totalCount - 1))
      return
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault()
      setActiveIdx((i) => Math.max(i - 1, 0))
      return
    }
    if (e.key === 'Enter') {
      if (isImeComposing(e.nativeEvent)) return
      e.preventDefault()
      const row = byIdx.get(activeIdx)
      if (row?.type === 'cmd') runCmd(row.cmd)
      else if (row?.type === 'file') runFile(row.file)
      return
    }
  }

  const searchLabel = page ? page.title : commandMode ? 'Search commands' : 'Search files'
  const emptyLabel = !query.trim() && page
    ? 'Nothing here yet'
    : `No ${page ? 'results' : commandMode ? 'commands' : 'files'} match "${query}"`

  return (
    <AppOverlay
      open={true}
      onClose={onClose}
      label={hasFiles ? 'Quick Open' : 'Command palette'}
      variant="palette"
    >
      <div onKeyDown={handleKeyDown}>
          {/* Search input */}
          <div className="flex items-center gap-2.5 border-b border-(--color-border) bg-(--bg-sidebar) px-3.5 py-2.5 md:py-3">
            <Search size={14} className="shrink-0 text-(--color-text-muted)" />
            {page && (
              <button
                type="button"
                onClick={() => showPage(null)}
                aria-label="Back to all commands"
                className="inline-flex shrink-0 items-center gap-0.5 rounded-xs bg-(--bg-key) py-0.5 pl-0.5 pr-1.5 text-[11px] font-medium text-(--color-text-2) transition-colors hover:text-(--color-text) focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-(--focus-ring)/40"
              >
                <ChevronLeft size={12} aria-hidden="true" />
                {page.title}
              </button>
            )}
            <input
              ref={inputRef}
              value={query}
              onChange={(e) => handleQueryChange(e.target.value)}
              placeholder={page ? page.page.placeholder : hasFiles ? 'Search files…' : 'Search commands…'}
              autoCorrect="off"
              autoCapitalize="off"
              spellCheck={false}
              className="min-w-0 flex-1 border-none bg-transparent text-xs text-(--color-text) placeholder-(--color-text-muted)/60 outline-none ring-0 focus:border-none focus:outline-none focus:ring-0 focus-visible:border-none focus-visible:outline-none focus-visible:ring-0 md:text-sm"
              aria-label={searchLabel}
            />
            {query && (
              <button
                onClick={() => handleQueryChange('')}
                className="rounded-xs px-1.5 py-1 text-[11px] text-(--color-text-muted) transition-colors hover:bg-(--bg-key) hover:text-(--color-text-2) focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-(--focus-ring)/40"
              >
                Clear
              </button>
            )}
          </div>

          {/* Command + file list */}
          <div ref={listRef} className="max-h-80 overflow-y-auto overscroll-contain p-1.5 md:max-h-[28rem]">
            {totalCount === 0 ? (
              <div className="flex flex-col items-center justify-center gap-1 px-4 py-8 text-center" role="status">
                <p className="text-xs text-(--color-text-muted)">{emptyLabel}</p>
                {query.trim() && (
                  <p className="text-[11px] text-(--color-text-subtle)">Try searching for another keyword or path</p>
                )}
              </div>
            ) : (
              rows.map((row, i) => {
                if (row.type === 'header') {
                  return (
                    <p
                      key={`h-${i}`}
                      className="px-2.5 pb-1 pt-2 label-caps text-(--color-text-subtle) select-none"
                    >
                      {row.label}
                    </p>
                  )
                }
                if (row.type === 'file') {
                  return (
                    <FileRow
                      key={row.file.path}
                      file={row.file}
                      idx={row.idx}
                      isActive={row.idx === activeIdx}
                      onRun={runFile}
                      onActivate={setActiveIdx}
                    />
                  )
                }
                return (
                  <CommandRow
                    key={row.cmd.id}
                    cmd={row.cmd}
                    idx={row.idx}
                    isActive={row.idx === activeIdx}
                    onRun={runCmd}
                    onActivate={setActiveIdx}
                  />
                )
              })
            )}
          </div>

          <div className="flex items-center gap-2 border-t border-(--color-border) bg-(--bg-sidebar) px-3 py-2">
            <kbd className="rounded-xs border border-(--color-border) bg-(--bg-card) px-1 py-0.5 font-mono text-xs md:text-[11px] text-(--color-text-muted)">↑↓</kbd>
            <span className="text-xs text-(--color-text-muted)">navigate</span>
            <kbd className="rounded-xs border border-(--color-border) bg-(--bg-card) px-1 py-0.5 font-mono text-xs md:text-[11px] text-(--color-text-muted)">↵</kbd>
            <span className="text-xs text-(--color-text-muted)">run</span>
            <kbd className="rounded-xs border border-(--color-border) bg-(--bg-card) px-1 py-0.5 font-mono text-xs md:text-[11px] text-(--color-text-muted)">Esc</kbd>
            <span className="text-xs text-(--color-text-muted)">{page ? 'back' : 'close'}</span>
            {hasFiles && !commandMode && (
              <>
                <kbd className="rounded-xs border border-(--color-border) bg-(--bg-card) px-1 py-0.5 font-mono text-xs md:text-[11px] text-(--color-text-muted)">&gt;</kbd>
                <span className="text-xs text-(--color-text-muted)">commands</span>
              </>
            )}
            {hasFiles && !commandMode && filesTruncated && (
              <Tooltip className="ml-auto min-w-0">
                <TooltipTrigger
                  className="min-w-0"
                  render={<span className="truncate text-xs text-(--color-warning)">file list truncated</span>}
                />
                <TooltipContent>The workspace has more files than the listing cap, so some files are not searchable here.</TooltipContent>
              </Tooltip>
            )}
          </div>
      </div>
    </AppOverlay>
  )
}

interface FileRowProps {
  file: WorkspaceFileInfo
  idx: number
  isActive: boolean
  onRun: (file: WorkspaceFileInfo) => void
  onActivate: (idx: number) => void
}

function FileRow({ file, idx, isActive, onRun, onActivate }: FileRowProps) {
  return (
    <button
      data-idx={idx}
      type="button"
      onClick={() => onRun(file)}
      onMouseEnter={() => onActivate(idx)}
      className={`group flex w-full min-w-0 items-center justify-between gap-3 rounded-sm border border-transparent px-2.5 py-1.5 text-left transition-colors focus:outline-none focus-visible:outline-none ${
        isActive
          ? 'border-(--color-border-strong) bg-(--bg-key)/60 text-(--color-text)'
          : 'text-(--color-text-2) hover:border-(--color-border) hover:bg-(--bg-card)'
      }`}
    >
      <div className="min-w-0 flex-1 overflow-hidden">
        <span className="block truncate font-mono text-xs font-medium text-(--color-text)">
          {file.name}
        </span>
        {file.path !== file.name && (
          <span
            className="block truncate font-mono text-xs md:text-[11px] text-(--color-text-muted)"
            title={file.path}
          >
            {file.path}
          </span>
        )}
      </div>
      {isActive && <CornerDownLeft size={12} className="shrink-0 text-(--color-text-muted)" />}
    </button>
  )
}

interface CommandRowProps {
  cmd: Command
  idx: number
  isActive: boolean
  onRun: (cmd: Command) => void
  onActivate: (idx: number) => void
}

function CommandRow({ cmd, idx, isActive, onRun, onActivate }: CommandRowProps) {
  return (
    <button
      data-idx={idx}
      type="button"
      onClick={() => onRun(cmd)}
      onMouseEnter={() => onActivate(idx)}
      className={`group flex w-full min-w-0 items-center justify-between gap-3 rounded-sm border border-transparent px-2.5 py-1.5 text-left transition-colors focus:outline-none focus-visible:outline-none ${
        isActive
          ? 'border-(--color-border-strong) bg-(--bg-key)/60 text-(--color-text)'
          : 'text-(--color-text-2) hover:border-(--color-border) hover:bg-(--bg-card)'
      }`}
    >
      <div className="min-w-0 flex-1 overflow-hidden">
        <span className="block truncate text-xs font-medium text-(--color-text)">{cmd.label}</span>
        {cmd.description && (
          <span className="block truncate text-[11px] text-(--color-text-muted)">
            {cmd.description}
          </span>
        )}
      </div>
      <div className="flex shrink-0 items-center gap-2">
        {cmd.shortcut && (
          <kbd className="rounded-xs border border-(--color-border) bg-(--bg-card) px-1.5 py-0.5 font-mono text-xs md:text-[11px] text-(--color-text-muted)">
            {cmd.shortcut}
          </kbd>
        )}
        {cmd.page ? (
          <ChevronRight size={12} className="shrink-0 text-(--color-text-muted)" aria-hidden="true" />
        ) : isActive && (
          <CornerDownLeft size={12} className="shrink-0 text-(--color-text-muted)" />
        )}
      </div>
    </button>
  )
}
