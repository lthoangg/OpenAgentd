/**
 * CommandPalette — ⌘P / Ctrl+P unified search overlay.
 *
 * Shows a searchable list of commands and (in coding mode) workspace files.
 * Each command has a label, description, keyboard shortcut hint, and an action
 * callback. File items are injected as a "Files" group that appears first.
 * Activated/dismissed from the parent via the `onClose` prop.
 */

import { useState, useRef, useEffect, useCallback, useMemo } from 'react'
import { useDebouncedCallback } from '@tanstack/react-pacer'
import fuzzysort from 'fuzzysort'
import { Search, CornerDownLeft } from 'lucide-react'
import { AppOverlay } from '@/components/ui/app-overlay'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import type { WorkspaceFileInfo } from '@/api/types'

export interface Command {
  id: string
  label: string
  description?: string
  shortcut?: string
  /** Optional category for grouping */
  group?: string
  action: () => void
}

// Max file rows shown in the palette — matches the old inline file-search
// dialog cap to keep the list snappy with large workspaces.
const MAX_FILE_ROWS = 30

interface CommandPaletteProps {
  commands: Command[]
  onClose: () => void
  /** Raw workspace files (coding mode only). Filtered + capped inside. */
  workspaceFiles?: WorkspaceFileInfo[]
  /**
   * The backend listing hit its own cap, so files the user knows exist may be
   * absent from ``workspaceFiles`` entirely. Say so rather than letting a
   * "my file isn't in the palette" mystery repeat.
   */
  filesTruncated?: boolean
  /** Called when the user selects a file row. */
  onFileOpen?: (file: WorkspaceFileInfo) => void
}

export function CommandPalette({ commands, onClose, workspaceFiles = [], filesTruncated = false, onFileOpen }: CommandPaletteProps) {
  const [query, setQuery] = useState('')
  const [debouncedQuery, setDebouncedQuery] = useState('')
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
  // Focus input on open
  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  // Build the flat filtered+grouped list in one memoised pass.
  //
  // Files: ranked with fuzzysort, the same engine the `@`-mention picker and
  // the model pickers use, so `dockcom` finds `docker-compose.yml` here too.
  // `limit` caps the work inside fuzzysort rather than filtering the whole
  // workspace into an intermediate array and slicing afterwards.
  //
  // Commands: substring matched across label/description/group. Kept as a
  // substring match deliberately — command labels are a small, curated set the
  // user is scanning visually, and fuzzy matching a 20-item list mostly just
  // surfaces surprising rows.
  const hasFiles = workspaceFiles.length > 0 && Boolean(onFileOpen)

  type FileRow = { type: 'file'; file: WorkspaceFileInfo; idx: number }
  type CmdRow  = { type: 'header'; label: string } | { type: 'cmd'; cmd: Command; idx: number }
  type Row = FileRow | CmdRow

  const { rows, totalCount, byIdx } = useMemo(() => {
    const q = query.trim().toLowerCase()
    const fileQ = (debouncedQuery || query).trim().toLowerCase()

    // ── Commands ──────────────────────────────────────────────────────────────
    const filteredCmds = commands.filter((cmd) =>
      !q ||
      cmd.label.toLowerCase().includes(q) ||
      cmd.description?.toLowerCase().includes(q) ||
      cmd.group?.toLowerCase().includes(q),
    )

    // ── Files (ranked + capped) ───────────────────────────────────────────────
    let filteredFiles: WorkspaceFileInfo[] = []
    if (hasFiles) {
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

    // Commands group (with headers)
    const groups = new Map<string, Command[]>()
    for (const cmd of filteredCmds) {
      const g = cmd.group ?? ''
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
  }, [commands, workspaceFiles, hasFiles, query, debouncedQuery])

  // Reset active index whenever query changes.
  const prevQueryRef = useRef(query)
  if (prevQueryRef.current !== query) {
    prevQueryRef.current = query
    if (activeIdx !== 0) setActiveIdx(0)
  }

  // Scroll active item into view
  useEffect(() => {
    const el = listRef.current?.querySelector(`[data-idx="${activeIdx}"]`) as HTMLElement | null
    el?.scrollIntoView({ block: 'nearest' })
  }, [activeIdx])

  const runCmd = useCallback(
    (cmd: Command) => { onClose(); cmd.action() },
    [onClose],
  )

  const runFile = useCallback(
    (file: WorkspaceFileInfo) => { onClose(); onFileOpen?.(file) },
    [onClose, onFileOpen],
  )

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') { onClose(); return }
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
      e.preventDefault()
      const row = byIdx.get(activeIdx)
      if (row?.type === 'cmd') runCmd(row.cmd)
      else if (row?.type === 'file') runFile(row.file)
      return
    }
  }

  return (
    <AppOverlay
      open={true}
      onClose={onClose}
      label="Command palette"
      variant="palette"
    >
      <div onKeyDown={handleKeyDown}>
          {/* Search input */}
          <div className="flex items-center gap-2.5 border-b border-(--color-border) bg-(--bg-sidebar) px-3.5 py-2.5 md:py-3">
            <Search size={14} className="shrink-0 text-(--color-text-muted)" />
            <input
              ref={inputRef}
              value={query}
              onChange={(e) => handleQueryChange(e.target.value)}
              placeholder={hasFiles ? 'Search files and commands…' : 'Search commands…'}
              className="min-w-0 flex-1 bg-transparent text-xs text-(--color-text) placeholder-(--color-text-muted)/60 outline-none md:text-sm"
              aria-label="Search commands"
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
                <p className="text-xs text-(--color-text-muted)">
                  No {hasFiles ? 'files or commands' : 'commands'} match "{query}"
                </p>
                <p className="text-[11px] text-(--color-text-subtle)">Try searching for another keyword or path</p>
              </div>
            ) : (
              rows.map((row, i) => {
                if (row.type === 'header') {
                  return (
                    <p
                      key={`h-${i}`}
                      className="px-2.5 pb-1 pt-2 font-mono text-[10px] font-semibold uppercase tracking-[0.08em] text-(--color-text-subtle) select-none"
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
            <kbd className="rounded-xs border border-(--color-border) bg-(--bg-card) px-1 py-0.5 font-mono text-[10px] text-(--color-text-muted)">↑↓</kbd>
            <span className="text-xs text-(--color-text-muted)">navigate</span>
            <kbd className="rounded-xs border border-(--color-border) bg-(--bg-card) px-1 py-0.5 font-mono text-[10px] text-(--color-text-muted)">↵</kbd>
            <span className="text-xs text-(--color-text-muted)">run</span>
            <kbd className="rounded-xs border border-(--color-border) bg-(--bg-card) px-1 py-0.5 font-mono text-[10px] text-(--color-text-muted)">Esc</kbd>
            <span className="text-xs text-(--color-text-muted)">close</span>
            {hasFiles && filesTruncated && (
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
      className={`group flex w-full min-w-0 items-center justify-between gap-3 rounded-sm border border-transparent px-2.5 py-1.5 text-left transition-colors ${
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
            className="block truncate font-mono text-[10.5px] text-(--color-text-muted)"
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
      className={`group flex w-full min-w-0 items-center justify-between gap-3 rounded-sm border border-transparent px-2.5 py-1.5 text-left transition-colors ${
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
          <kbd className="rounded-xs border border-(--color-border) bg-(--bg-card) px-1.5 py-0.5 font-mono text-[10px] text-(--color-text-muted)">
            {cmd.shortcut}
          </kbd>
        )}
        {isActive && (
          <CornerDownLeft size={12} className="shrink-0 text-(--color-text-muted)" />
        )}
      </div>
    </button>
  )
}
