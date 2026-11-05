/**
 * CommandPalette — the app's one search overlay: ⌘K / Ctrl+K searches
 * commands, sessions and files together; ⌘P / Ctrl+P opens the same overlay
 * scoped to files ("Find file").
 *
 * With an empty query ⌘K lists the commands (browse). Typing shows results
 * in up to three labeled groups — Commands, Sessions, Files — in one
 * keyboard-navigable list: the arrows run straight across group boundaries
 * and the headings are not rows. Each group is capped so one of them cannot
 * push the others off screen.
 *
 * Scope: the Files scope shows a "Files" label before the field; Backspace
 * in an empty field (or a click on the label) widens to all groups. Typing
 * ``>`` first searches commands only.
 *
 * A command with a ``page`` opens a nested list in place, which may hold
 * pages of its own (Switch Workspace/Session… → a workspace → its sessions).
 * → opens the highlighted command's page once the caret is at the end of the
 * query; ← on an empty query steps back one level, to the command that
 * opened it.
 *
 * A trailing ``:line`` or ``:start-end`` (``Button.tsx:42``) searches for the
 * path and opens the pick at those lines, as VS Code's Go to File does.
 *
 * ``QuickOpen``, exported below, is the Files-scoped palette under its old name.
 */

import { useState, useRef, useEffect, useCallback, useId, useMemo } from 'react'
import { useDebouncedCallback } from '@tanstack/react-pacer'
import fuzzysort from 'fuzzysort'
import { Search, CornerDownLeft, ChevronLeft, ChevronRight, Loader2, X } from 'lucide-react'
import { AppOverlay } from '@/components/ui/app-overlay'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { isImeComposing } from '@/lib/keyboard/chord'
import type { WorkspaceFileInfo } from '@/api/types'
import { IGNORED_FILE_PENALTY } from '@/components/InputComposer.mentions'
import { hoverIntent } from '@/hooks/use-hover-intent'
import { useHeightGlide } from '@/hooks/useHeightGlide'

/** Nested list a command opens in place of running. */
export interface CommandPage {
  placeholder: string
  commands: Command[]
  /** Its rows are still loading: the list ends in a "Loading…" row instead of looking complete. */
  loading?: boolean
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
  /** Called when ``page`` opens, e.g. to start loading its rows. */
  onOpenPage?: () => void
  /** Listed only while the query is empty, e.g. New Session atop a session list. */
  browseOnly?: boolean
  action: () => void
}

/** A session the palette can open, built by whoever owns the session data. */
export interface PaletteSession {
  id: string
  /** What the query is matched against. */
  title: string
  /** Shown under the title, e.g. ``app · 3d``. */
  description: string
  /** When it was last active (ISO); among equal matches the newest comes first. */
  activityAt: string | null
  open: () => void
}

/** The palette's Sessions group. Without it the palette has no such group. */
export interface PaletteSessions {
  /** Candidates, any order; the palette keeps those matching the query and ranks them. */
  items: PaletteSession[]
  /** More sessions are still being looked up for the current query. */
  loading: boolean
  /**
   * Tells the owner what is being searched (trimmed; ``''`` when the Sessions
   * group is not showing) so it can look beyond the sessions it already has.
   */
  onSearch: (query: string) => void
}

/** What the palette searches as it opens. ``files`` is ⌘P's "Find file". */
export type PaletteScope = 'all' | 'files'

type SearchableCommand = Pick<Command, 'label' | 'description' | 'keywords' | 'group'>

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
export function commandScore(cmd: SearchableCommand, words: string[]): number | null {
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

/**
 * Sessions whose title holds every query word, best match first and, among
 * equal matches, newest first. Only the title counts: the workspace name and
 * age are shown for orientation, not searched.
 */
export function rankSessions(sessions: PaletteSession[], query: string): PaletteSession[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean)
  return sessions
    .map((session, index) => ({ session, index, score: commandScore({ label: session.title }, words) }))
    .filter((entry): entry is { session: PaletteSession; index: number; score: number } => entry.score !== null)
    .sort((a, b) =>
      a.score - b.score
      || (b.session.activityAt ?? '').localeCompare(a.session.activityAt ?? '')
      || a.index - b.index)
    .map((entry) => entry.session)
}

// Rows per group while every group shares the list (⌘K with a query).
const MAX_COMMAND_ROWS = 8
const MAX_SESSION_ROWS = 8
const MAX_GROUPED_FILE_ROWS = 20
// Rows in the Files scope, where files have the list to themselves. Matches
// the old inline file-search dialog cap to keep the list snappy with large
// workspaces.
const MAX_FILE_ROWS = 30

/**
 * Files ranked with fuzzysort, the same engine the `@`-mention picker and the
 * model pickers use, so `dockcom` finds `docker-compose.yml` here too.
 * `limit` caps the work inside fuzzysort rather than filtering the whole
 * workspace into an intermediate array and slicing afterwards.
 */
function rankFiles(files: WorkspaceFileInfo[], text: string, limit: number): WorkspaceFileInfo[] {
  if (!text) return files.slice(0, limit)
  return fuzzysort
    .go(text, files, {
      key: 'path',
      // Over-fetch so gitignored files can sink below visible ones.
      limit: limit * 2,
      // Matches the mention and model pickers.
      threshold: 0.2,
    })
    .map((r) => ({ file: r.obj, score: r.obj.ignored ? r.score - IGNORED_FILE_PENALTY : r.score }))
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((r) => r.file)
}

const LINE_SUFFIX = /:(\d+)(?::\d+)?(?:[-–](\d+))?$/

/** A file query split into the path to search for and the lines to open at. */
function splitLine(query: string): { text: string; line?: number; endLine?: number } {
  const match = LINE_SUFFIX.exec(query)
  if (!match || Number(match[1]) < 1) return { text: query }
  const line = Number(match[1])
  const endLine = match[2] !== undefined && Number(match[2]) > line ? Number(match[2]) : undefined
  return { text: query.slice(0, match.index), line, endLine }
}

export interface CommandPaletteProps {
  commands: Command[]
  onClose: () => void
  /** What it searches as it opens: everything (⌘K, the default) or only files (⌘P). */
  scope?: PaletteScope
  /** Query the overlay opens with, selected so typing replaces it. */
  initialQuery?: string
  /** Ids of the pages to open on, outermost first (e.g. Switch… › a workspace). */
  initialPagePath?: string[]
  /**
   * Raw workspace files (only with a workspace attached). Filtered + capped
   * inside. Together with ``onFileOpen`` they make the Files group.
   */
  workspaceFiles?: WorkspaceFileInfo[]
  /**
   * The backend listing hit its own cap, so files the user knows exist may be
   * absent from ``workspaceFiles`` entirely. Say so rather than letting a
   * "my file isn't in the palette" mystery repeat.
   */
  filesTruncated?: boolean
  /** The file listing has not arrived yet: Files shows "Loading…", not "no match". */
  filesLoading?: boolean
  /**
   * Called when the user selects a file row, with the query's ``:start-end``.
   * Its presence marks a workspace with files, even before the first one is
   * listed; without it there is no Files group.
   */
  onFileOpen?: (file: WorkspaceFileInfo, line?: number, endLine?: number) => void
  /** Adds the Sessions group. */
  sessions?: PaletteSessions
}

interface QuickOpenProps {
  workspaceFiles: WorkspaceFileInfo[]
  filesTruncated?: boolean
  filesLoading?: boolean
  /** Searched instead of files while the query starts with ``>``. */
  commands?: Command[]
  /** ``line`` (and ``endLine``) are set when the query ended in ``:line`` (``:start-end``). */
  onFileOpen: (file: WorkspaceFileInfo, line?: number, endLine?: number) => void
  onClose: () => void
  /** Query to open with, e.g. a file reference that matched several files. */
  initialQuery?: string
  sessions?: PaletteSessions
}

/** The palette scoped to files (⌘P, "Find file"). */
export function QuickOpen({ commands = [], ...props }: QuickOpenProps) {
  return <CommandPalette scope="files" commands={commands} {...props} />
}

/** One selectable row; ``idx`` is its place in the arrow-key order across groups. */
type PaletteRow =
  | { type: 'file'; file: WorkspaceFileInfo; idx: number }
  | { type: 'cmd'; cmd: Command; idx: number }

/** A run of rows under an optional heading. */
interface Section {
  key: string
  heading?: string
  rows: PaletteRow[]
  /** Ends with a "Loading…" row. */
  loading?: boolean
}

type Mode =
  /** Inside a command's page. */
  | 'page'
  /** ``>`` first: commands only. */
  | 'commands'
  | 'files'
  | 'all'

export function CommandPalette({
  commands,
  onClose,
  scope: initialScope = 'all',
  initialQuery = '',
  initialPagePath,
  workspaceFiles = [],
  filesTruncated = false,
  filesLoading = false,
  onFileOpen,
  sessions,
}: CommandPaletteProps) {
  const [query, setQuery] = useState(initialQuery)
  const [debouncedQuery, setDebouncedQuery] = useState(initialQuery)
  // Files when opened by ⌘P; Backspace in an empty field widens it to all.
  const [scope, setScope] = useState<PaletteScope>(initialScope)
  // Ids of the commands whose pages are open, outermost first. Resolved
  // against ``commands`` on each render, so an open page shows rows that
  // load after it opened.
  const [pagePath, setPagePath] = useState<string[]>(() => initialPagePath ?? [])
  // A path handed in may name pages whose commands have not loaded yet (the
  // workspace list arrives after the palette opens). It is kept, showing its
  // deepest page that exists, until it resolves in full once.
  const [pathSettled, setPathSettled] = useState(!initialPagePath?.length)
  // The command whose page was just left, highlighted again in its list.
  const [restoreId, setRestoreId] = useState<string | null>(null)
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
  const listClipRef = useRef<HTMLDivElement>(null)
  useHeightGlide(listClipRef, listRef)
  const headingId = useId()

  const trail = useMemo(() => {
    const out: { id: string; title: string; page: CommandPage; cmd: Command }[] = []
    let list = commands
    for (const id of pagePath) {
      const cmd = list.find((c) => c.id === id)
      if (!cmd?.page) break
      out.push({ id, title: cmd.label.replace(/…$/, ''), page: cmd.page, cmd })
      list = cmd.page.commands
    }
    return out
  }, [commands, pagePath])
  // A command on the path went away (its list reloaded without it): stay on
  // the deepest page that still exists.
  if (!pathSettled && trail.length === pagePath.length) setPathSettled(true)
  if (pathSettled && trail.length < pagePath.length) setPagePath(pagePath.slice(0, trail.length))
  const page = trail.length > 0 ? trail[trail.length - 1] : null

  // Each page on the path, once shown, tells its command (to load its rows).
  const openedPages = useRef(new Set<string>())
  useEffect(() => {
    for (const entry of trail) {
      if (openedPages.current.has(entry.id)) continue
      openedPages.current.add(entry.id)
      entry.cmd.onOpenPage?.()
    }
  }, [trail])

  // Focus input on open, selecting a handed-in query so typing replaces it.
  useEffect(() => {
    inputRef.current?.focus()
    inputRef.current?.select()
  }, [])

  // The file callback marks a workspace with files, even one whose listing is
  // still empty or loading.
  const hasFiles = Boolean(onFileOpen)
  const hasSessions = sessions !== undefined
  const sessionItems = sessions?.items
  const sessionsLoading = sessions?.loading ?? false
  const filesScoped = scope === 'files' && hasFiles
  const mode: Mode = page !== null ? 'page' : query.startsWith('>') ? 'commands' : filesScoped ? 'files' : 'all'

  // The Sessions group is the only one fed by the server; tell its owner what
  // to look for, and nothing while it is not showing.
  const sessionSearch = mode === 'all' ? query.trim() : ''
  const onSessionSearch = sessions?.onSearch
  useEffect(() => {
    onSessionSearch?.(sessionSearch)
  }, [onSessionSearch, sessionSearch])

  // Build the sections and their flat, arrow-key-ordered rows in one memoised pass.
  //
  // Commands: every query word must match the label, keywords, group, or
  // description (``commandScore``), so "compact mode" finds Toggle Reader
  // Mode; matches are ranked label-first and listed flat, best on top. Not
  // fuzzy — command labels are a small, curated set the user is scanning
  // visually, and fuzzy matching a 20-item list mostly surfaces surprising rows.
  // Sessions are matched by their title the same way; files with fuzzysort.
  const { sections, totalCount, byIdx } = useMemo(() => {
    const text = (mode === 'commands' ? query.slice(1) : query).trim().toLowerCase()
    const fileText = query.trim() ? splitLine((debouncedQuery || query).trim()).text.toLowerCase() : ''

    let idx = 0
    const cmdRows = (list: Command[]): PaletteRow[] => list.map((cmd) => ({ type: 'cmd', cmd, idx: idx++ }))
    const fileRows = (list: WorkspaceFileInfo[]): PaletteRow[] => list.map((file) => ({ type: 'file', file, idx: idx++ }))
    const out: Section[] = []

    if (mode === 'page' || mode === 'commands' || (mode === 'all' && !text)) {
      const list = page ? page.page.commands : commands
      if (text) {
        // A ranked search result is one list.
        out.push({ key: 'commands', rows: cmdRows(rankCommands(list.filter((cmd) => !cmd.browseOnly), text)) })
      } else {
        // Browsing: commands under their group headers.
        const groups = new Map<string, Command[]>()
        for (const cmd of list) {
          const g = cmd.group ?? ''
          if (!groups.has(g)) groups.set(g, [])
          groups.get(g)!.push(cmd)
        }
        for (const [group, cmds] of groups.entries()) {
          out.push({ key: `group:${group}`, heading: group || undefined, rows: cmdRows(cmds) })
        }
      }
      // A page opened once and fills in later: say so under what it has.
      if (page?.page.loading) {
        if (out.length > 0) out[out.length - 1].loading = true
        else out.push({ key: 'loading', rows: [], loading: true })
      }
    } else if (mode === 'files') {
      const files = rankFiles(workspaceFiles, fileText, MAX_FILE_ROWS)
      out.push({ key: 'files', rows: fileRows(files), loading: files.length === 0 && filesLoading })
    } else {
      const found = rankCommands(commands.filter((cmd) => !cmd.browseOnly), text).slice(0, MAX_COMMAND_ROWS)
      out.push({ key: 'commands', heading: 'Commands', rows: cmdRows(found) })
      if (sessionItems) {
        const ranked = rankSessions(sessionItems, text).slice(0, MAX_SESSION_ROWS)
        const rows = cmdRows(ranked.map((s): Command => ({
          id: `session:${s.id}`,
          label: s.title,
          description: s.description,
          action: s.open,
        })))
        out.push({ key: 'sessions', heading: 'Sessions', rows, loading: rows.length === 0 && sessionsLoading })
      }
      if (hasFiles && fileText) {
        const files = rankFiles(workspaceFiles, fileText, MAX_GROUPED_FILE_ROWS)
        out.push({ key: 'files', heading: 'Files', rows: fileRows(files), loading: files.length === 0 && filesLoading })
      }
    }

    // A group with nothing to show and nothing coming is left out.
    const shown = out.filter((section) => section.rows.length > 0 || section.loading)
    // Direct idx→row map for O(1) Enter lookup.
    const byIdx = new Map<number, PaletteRow>()
    for (const section of shown) for (const row of section.rows) byIdx.set(row.idx, row)
    return { sections: shown, totalCount: idx, byIdx }
  }, [commands, page, mode, workspaceFiles, hasFiles, filesLoading, sessionItems, sessionsLoading, query, debouncedQuery])

  // Reset active index whenever query changes.
  const [prevQuery, setPrevQuery] = useState(query)
  if (prevQuery !== query) {
    setPrevQuery(query)
    if (activeIdx !== 0) setActiveIdx(0)
  }

  // Back from a page: land on the command that opened it, not the top row.
  // Runs after the query reset above, so this index wins.
  if (restoreId !== null) {
    setRestoreId(null)
    for (const row of byIdx.values()) {
      if (row.type === 'cmd' && row.cmd.id === restoreId) {
        setActiveIdx(row.idx)
        break
      }
    }
  }

  // Scroll active item into view
  useEffect(() => {
    const el = listRef.current?.querySelector(`[data-idx="${activeIdx}"]`) as HTMLElement | null
    el?.scrollIntoView({ block: 'nearest' })
  }, [activeIdx])

  const showPage = useCallback((next: Command | null) => {
    // Steps from the pages shown, not an unresolved handed-in path.
    const shown = trail.map((entry) => entry.id)
    if (next === null) {
      const left = shown[shown.length - 1] ?? null
      if (left !== null) openedPages.current.delete(left)
      setRestoreId(left)
      setPagePath(shown.slice(0, -1))
    } else {
      setPagePath([...shown, next.id])
    }
    setPathSettled(true)
    setQuery('')
    setDebouncedQuery('')
    setActiveIdx(0)
    inputRef.current?.focus()
  }, [trail])

  const widenScope = useCallback(() => {
    setScope('all')
    setActiveIdx(0)
    inputRef.current?.focus()
  }, [])

  const runCmd = useCallback(
    (cmd: Command) => {
      if (cmd.page) {
        showPage(cmd)
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
    const plainKey = !e.shiftKey && !e.altKey && !e.metaKey && !e.ctrlKey && !isImeComposing(e.nativeEvent)
    if (e.key === 'Backspace' && plainKey && query === '' && filesScoped) {
      // Nothing left to delete: the next step is leaving the Files scope.
      e.preventDefault()
      widenScope()
      return
    }
    if (e.key === 'ArrowRight' && plainKey) {
      // In the query, → moves the caret until it reaches the end.
      const input = e.target instanceof HTMLInputElement ? e.target : null
      const caretAtEnd = !input || (input.selectionStart === input.value.length && input.selectionEnd === input.value.length)
      const row = byIdx.get(activeIdx)
      if (caretAtEnd && row?.type === 'cmd' && row.cmd.page) {
        e.preventDefault()
        runCmd(row.cmd)
        return
      }
    }
    if (e.key === 'ArrowLeft' && plainKey && page && query === '') {
      e.preventDefault()
      showPage(null)
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

  // Names: the overlay is "Command palette"; ⌘P's scope is "Find file". The
  // prompt lists only what this palette can actually search.
  const allPrompt = hasFiles
    ? hasSessions ? 'Search commands, sessions and files' : 'Search commands and files'
    : hasSessions ? 'Search commands and sessions' : 'Search commands'
  const searchLabel = page ? page.title : filesScoped ? 'Find file' : allPrompt
  const placeholder = page ? page.page.placeholder : filesScoped ? 'Find file…' : `${allPrompt}…`
  const activeRow = byIdx.get(activeIdx)
  const activeOpensPage = activeRow?.type === 'cmd' && Boolean(activeRow.cmd.page)
  const searchesFiles = hasFiles && (mode === 'files' || mode === 'all')
  const emptyKind = page ? 'results' : mode === 'files' ? 'files' : mode === 'commands' || (!hasFiles && !hasSessions) ? 'commands' : 'results'
  const emptyLabel = !query.trim() && page ? 'Nothing here yet' : `No ${emptyKind} match "${query}"`

  return (
    <AppOverlay
      open={true}
      onClose={onClose}
      label="Command palette"
      variant="palette"
      // Not the first focusable: on a nested page that is the back chip.
      initialFocus={inputRef}
    >
      {/* A shrinkable column: the palette is capped to the visible area above
          the iOS keyboard (``.app-overlay-palette``), so the list gives way
          while the search field and hints stay put. */}
      <div onKeyDown={handleKeyDown} className="flex min-h-0 flex-col">
          {/* Search input */}
          <div className="flex shrink-0 items-center gap-2.5 border-b border-(--color-border) bg-(--bg-sidebar) px-3.5 py-2.5 md:py-3">
            <Search size={14} className="shrink-0 text-(--color-text-muted)" />
            {page && (
              <button
                type="button"
                onClick={() => showPage(null)}
                aria-label={trail.length > 1 ? `Back to ${trail[trail.length - 2].title}` : 'Back to all commands'}
                className="inline-flex min-w-0 max-w-[60%] items-center gap-0.5 rounded-xs bg-(--bg-key) py-0.5 pl-0.5 pr-1.5 text-meta font-medium text-(--color-text-2) transition-colors hover:text-(--color-text) focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-(--focus-ring)"
              >
                <ChevronLeft size={12} className="shrink-0" aria-hidden="true" />
                <span className="truncate">{trail.map((t) => t.title).join(' › ')}</span>
              </button>
            )}
            {/* The scope; its × widens to everything, as Backspace does. The
                ``>`` prefix is its own mark, so the label steps aside for it. */}
            {mode === 'files' && (
              <button
                type="button"
                onClick={widenScope}
                aria-label="Files only. Search everything instead"
                className="inline-flex shrink-0 items-center gap-1 rounded-xs bg-(--bg-key) py-0.5 pl-1.5 pr-1 text-meta font-medium text-(--color-text-2) transition-colors hover:text-(--color-text) focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-(--focus-ring)"
              >
                <span>Files</span>
                <X size={10} className="shrink-0" aria-hidden="true" />
              </button>
            )}
            <input
              ref={inputRef}
              value={query}
              onChange={(e) => handleQueryChange(e.target.value)}
              placeholder={placeholder}
              autoCorrect="off"
              autoCapitalize="off"
              spellCheck={false}
              enterKeyHint="search"
              // 16px on touch phones, or iOS zooms the page when the field takes focus.
              className="min-w-0 flex-1 border-none bg-transparent text-xs text-(--color-text) placeholder-(--color-text-muted) outline-none ring-0 focus:border-none focus:outline-none focus:ring-0 focus-visible:border-none focus-visible:outline-none focus-visible:ring-0 md:text-sm max-md:pointer-coarse:text-base"
              aria-label={searchLabel}
            />
            {query && (
              <button
                onClick={() => handleQueryChange('')}
                className="rounded-xs px-1.5 py-1 text-meta text-(--color-text-muted) transition-colors hover:bg-(--bg-key) hover:text-(--color-text-2) focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-(--focus-ring)"
              >
                Clear
              </button>
            )}
          </div>

          {/* Results: groups of rows, walked by the arrows as one list. */}
          {/* The clip glides to the list's new height as results narrow or
              grow (useHeightGlide), so the card's edge never jumps per key. */}
          <div ref={listClipRef} className="flex min-h-0 flex-col overflow-hidden">
          <div ref={listRef} className="max-h-80 min-h-0 overflow-y-auto overscroll-contain p-1.5 md:max-h-[28rem]">
            {sections.length === 0 ? (
              <div className="flex flex-col items-center justify-center gap-1 px-4 py-8 text-center" role="status">
                <p className="text-xs text-(--color-text-muted)">{emptyLabel}</p>
                {query.trim() && (
                  <p className="text-meta text-(--color-text-subtle)">Try searching for another keyword or path</p>
                )}
              </div>
            ) : (
              sections.map((section) => (
                <div
                  key={section.key}
                  role={section.heading ? 'group' : undefined}
                  aria-labelledby={section.heading ? `${headingId}-${section.key}` : undefined}
                >
                  {section.heading && (
                    <p
                      id={`${headingId}-${section.key}`}
                      className="px-2.5 pb-1 pt-2 text-meta font-medium text-(--color-text-muted) select-none"
                    >
                      {section.heading}
                    </p>
                  )}
                  {section.rows.map((row) =>
                    row.type === 'file' ? (
                      <FileRow
                        key={row.file.path}
                        file={row.file}
                        idx={row.idx}
                        isActive={row.idx === activeIdx}
                        onRun={runFile}
                        onActivate={setActiveIdx}
                      />
                    ) : (
                      <CommandRow
                        key={row.cmd.id}
                        cmd={row.cmd}
                        idx={row.idx}
                        isActive={row.idx === activeIdx}
                        onRun={runCmd}
                        onActivate={setActiveIdx}
                      />
                    ),
                  )}
                  {section.loading && <LoadingRow />}
                </div>
              ))
            )}
          </div>
          </div>

          {/* Keyboard hints: phones have no keys to press, and the row would
              clip at 320px. */}
          <div data-palette-hints="" className="hidden shrink-0 items-center gap-2 border-t border-(--color-border-subtle) bg-(--bg-sidebar) px-3 py-2 md:flex">
            <kbd className="rounded-xs border border-(--color-border) bg-(--bg-card) px-1 py-0.5 font-mono text-xs md:text-meta text-(--color-text-muted)">↑↓</kbd>
            <span className="text-xs text-(--color-text-muted)">navigate</span>
            <kbd className="rounded-xs border border-(--color-border) bg-(--bg-card) px-1 py-0.5 font-mono text-xs md:text-meta text-(--color-text-muted)">↵</kbd>
            <span className="text-xs text-(--color-text-muted)">run</span>
            {activeOpensPage && (
              <>
                <kbd className="rounded-xs border border-(--color-border) bg-(--bg-card) px-1 py-0.5 font-mono text-xs md:text-meta text-(--color-text-muted)">→</kbd>
                <span className="text-xs text-(--color-text-muted)">open</span>
              </>
            )}
            {page && (
              <kbd className="rounded-xs border border-(--color-border) bg-(--bg-card) px-1 py-0.5 font-mono text-xs md:text-meta text-(--color-text-muted)">←</kbd>
            )}
            <kbd className="rounded-xs border border-(--color-border) bg-(--bg-card) px-1 py-0.5 font-mono text-xs md:text-meta text-(--color-text-muted)">Esc</kbd>
            <span className="text-xs text-(--color-text-muted)">{page ? 'back' : 'close'}</span>
            {mode === 'files' && (
              <>
                <kbd className="rounded-xs border border-(--color-border) bg-(--bg-card) px-1 py-0.5 font-mono text-xs md:text-meta text-(--color-text-muted)">&gt;</kbd>
                <span className="text-xs text-(--color-text-muted)">commands</span>
                {query === '' && (
                  <>
                    <kbd className="rounded-xs border border-(--color-border) bg-(--bg-card) px-1 py-0.5 font-mono text-xs md:text-meta text-(--color-text-muted)">⌫</kbd>
                    <span className="text-xs text-(--color-text-muted)">all</span>
                  </>
                )}
              </>
            )}
            {searchesFiles && filesTruncated && (
              <Tooltip className="ml-auto min-w-0">
                <TooltipTrigger
                  className="min-w-0"
                  render={<span className="truncate text-xs text-(--accent-orange-text)">file list truncated</span>}
                />
                <TooltipContent>The workspace has more files than the listing cap, so some files are not searchable here.</TooltipContent>
              </Tooltip>
            )}
          </div>
      </div>
    </AppOverlay>
  )
}

/** Stands in for rows still on their way, where "Nothing here yet" would be wrong. */
function LoadingRow() {
  return (
    <div
      role="status"
      aria-live="polite"
      className="flex items-center gap-2 px-2.5 py-1.5 text-xs text-(--color-text-muted)"
    >
      <Loader2 size={12} className="shrink-0 animate-spin" aria-hidden="true" />
      <span>Loading…</span>
    </div>
  )
}

/**
 * A palette row: transparent at rest; the active row (keyboard, or a real
 * mouse move via ``hoverIntent``) fills with the theme accent and inverts
 * every word in it, like an OS menu (``.oa-menu-item`` in index.css). It is
 * keyed: a parked pointer does not light a second row (``oa-menu-item-keyed``).
 */
const PALETTE_ROW_CLASS =
  'oa-menu-item oa-menu-item-keyed group flex w-full min-w-0 items-center justify-between gap-3 rounded-sm px-2.5 py-1.5 text-left text-(--color-text-2) focus:outline-none focus-visible:outline-none pointer-coarse:min-h-9'

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
      {...hoverIntent(() => onActivate(idx))}
      data-highlighted={isActive ? '' : undefined}
      className={PALETTE_ROW_CLASS}
    >
      <div className="min-w-0 flex-1 overflow-hidden">
        <span className={`block truncate font-mono text-xs font-medium ${file.ignored ? 'text-(--color-text-muted)' : 'text-(--color-text)'}`}>
          {file.name}
        </span>
        {file.path !== file.name && (
          <span
            className="block truncate font-mono text-xs md:text-meta text-(--color-text-muted)"
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
      {...hoverIntent(() => onActivate(idx))}
      data-highlighted={isActive ? '' : undefined}
      className={PALETTE_ROW_CLASS}
    >
      <div className="min-w-0 flex-1 overflow-hidden">
        <span className="block truncate text-xs font-medium text-(--color-text)">{cmd.label}</span>
        {cmd.description && (
          <span className="block truncate text-meta text-(--color-text-muted)">
            {cmd.description}
          </span>
        )}
      </div>
      <div className="flex shrink-0 items-center gap-2">
        {cmd.shortcut && (
          <kbd className="rounded-xs border border-(--color-border) bg-(--bg-card) px-1.5 py-0.5 font-mono text-xs md:text-meta text-(--color-text-muted)">
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
