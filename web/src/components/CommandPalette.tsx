/**
 * CommandPalette — ⌘P / Ctrl+P unified search overlay.
 *
 * Shows a searchable list of commands and (in coding mode) workspace files.
 * Each command has a label, description, keyboard shortcut hint, and an action
 * callback. File items are injected as a "Files" group that appears first.
 * Activated/dismissed from the parent via the `onClose` prop.
 */

import { useState, useRef, useEffect, useCallback, useMemo } from 'react'
import { Search, CornerDownLeft } from 'lucide-react'
import { AppOverlay } from '@/components/ui/app-overlay'
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
  /** Called when the user selects a file row. */
  onFileOpen?: (file: WorkspaceFileInfo) => void
}

export function CommandPalette({ commands, onClose, workspaceFiles = [], onFileOpen }: CommandPaletteProps) {
  const [query, setQuery] = useState('')
  const [activeIdx, setActiveIdx] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  // Focus input on open
  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  // Build the flat filtered+grouped list in one memoised pass.
  //
  // Files: filter the raw WorkspaceFileInfo array by query then cap at
  // MAX_FILE_ROWS — this is intentionally cheap (no object allocation until
  // after the slice) and matches the old inline file-search dialog behaviour.
  //
  // Commands: filtered as before, always shown first.
  const hasFiles = workspaceFiles.length > 0 && Boolean(onFileOpen)

  type FileRow = { type: 'file'; file: WorkspaceFileInfo; idx: number }
  type CmdRow  = { type: 'header'; label: string } | { type: 'cmd'; cmd: Command; idx: number }
  type Row = FileRow | CmdRow

  const { rows, totalCount, byIdx } = useMemo(() => {
    const q = query.trim().toLowerCase()

    // ── Commands ──────────────────────────────────────────────────────────────
    const filteredCmds = commands.filter((cmd) =>
      !q ||
      cmd.label.toLowerCase().includes(q) ||
      cmd.description?.toLowerCase().includes(q) ||
      cmd.group?.toLowerCase().includes(q),
    )

    // ── Files (capped) ────────────────────────────────────────────────────────
    let filteredFiles: WorkspaceFileInfo[] = []
    if (hasFiles) {
      filteredFiles = q
        ? workspaceFiles.filter((f) => f.path.toLowerCase().includes(q)).slice(0, MAX_FILE_ROWS)
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
  }, [commands, workspaceFiles, hasFiles, query])

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
          <div className="flex items-center gap-2 border-b border-(--color-border) bg-(--bg-sidebar) px-3 py-2.5">
            <Search size={13} className="shrink-0 text-(--color-text-muted)" />
            <input
              ref={inputRef}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={hasFiles ? 'Search files and commands…' : 'Search commands…'}
              className="min-w-0 flex-1 bg-transparent text-xs text-(--color-text) placeholder-(--color-text-muted)/60 outline-none"
              aria-label="Search commands"
            />
            {query && (
              <button
                onClick={() => setQuery('')}
                className="rounded-xs px-1.5 py-1 text-[11px] text-(--color-text-muted) hover:bg-(--bg-key) hover:text-(--color-text-2)"
              >
                Clear
              </button>
            )}
          </div>

          {/* Command + file list */}
          <div ref={listRef} className="max-h-80 overflow-y-auto overscroll-contain p-1.5">
            {totalCount === 0 ? (
              <p className="px-4 py-6 text-center text-sm text-(--color-text-muted)">
                No {hasFiles ? 'files or commands' : 'commands'} match "{query}"
              </p>
            ) : (
              rows.map((row, i) => {
                if (row.type === 'header') {
                  return (
                    <p
                      key={`h-${i}`}
                      className="px-2 pb-1 pt-2.5 text-[10px] font-semibold uppercase tracking-widest text-(--color-text-muted)"
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
      onClick={() => onRun(file)}
      onMouseEnter={() => onActivate(idx)}
      className={`flex w-full items-center gap-2 rounded-sm border border-transparent px-2.5 py-2 text-left ${
        isActive
          ? 'border-(--color-border-strong) bg-(--bg-key)/60 text-(--color-text)'
          : 'text-(--color-text-2) hover:border-(--color-border) hover:bg-(--bg-card)'
      }`}
    >
      <div className="min-w-0 flex-1">
        <span className="block truncate font-mono text-xs font-medium">{file.name}</span>
        <span className="block truncate text-xs text-(--color-text-muted)">{file.path}</span>
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
    <div>
      <button
        data-idx={idx}
        onClick={() => onRun(cmd)}
        onMouseEnter={() => onActivate(idx)}
        className={`flex w-full items-center gap-2 rounded-sm border border-transparent px-2.5 py-2 text-left ${
          isActive
            ? 'border-(--color-border-strong) bg-(--bg-key)/60 text-(--color-text)'
            : 'text-(--color-text-2) hover:border-(--color-border) hover:bg-(--bg-card)'
        }`}
      >
        <div className="min-w-0 flex-1">
          <span className="block text-xs font-medium">{cmd.label}</span>
          {cmd.description && (
            <span className="block truncate text-xs text-(--color-text-muted)">
              {cmd.description}
            </span>
          )}
        </div>
        {cmd.shortcut && (
          <kbd className="shrink-0 rounded-xs border border-(--color-border) bg-(--bg-card) px-1.5 py-0.5 font-mono text-[10px] text-(--color-text-muted)">
            {cmd.shortcut}
          </kbd>
        )}
        {isActive && (
          <CornerDownLeft size={12} className="shrink-0 text-(--color-text-muted)" />
        )}
      </button>
    </div>
  )
}
