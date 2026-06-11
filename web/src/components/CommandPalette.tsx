/**
 * CommandPalette — Ctrl+P command search overlay.
 *
 * Shows a searchable list of commands. Each command has a label, description,
 * keyboard shortcut hint, and an action callback. Activated/dismissed from
 * the parent via the `onClose` prop.
 */

import { useState, useRef, useEffect, useCallback, useMemo } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { Search, CornerDownLeft } from 'lucide-react'
import { useProximityTracker, useProximityIntensity } from '@/hooks/useProximity'
import { useModalFocus } from '@/hooks/useModalFocus'
import { useReducedMotion } from '@/hooks/useReducedMotion'
import { usePlatform } from '@/hooks/use-platform'
import { useIsMobile } from '@/hooks/use-mobile'

export interface Command {
  id: string
  label: string
  description?: string
  shortcut?: string
  /** Optional category for grouping */
  group?: string
  action: () => void
}

interface CommandPaletteProps {
  commands: Command[]
  onClose: () => void
}

export function CommandPalette({ commands, onClose }: CommandPaletteProps) {
  const [query, setQuery] = useState('')
  const [activeIdx, setActiveIdx] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const mouseY = useProximityTracker(listRef)
  const prefersReducedMotion = useReducedMotion()
  const isMobile = useIsMobile()
  const { isTauri, os } = usePlatform()
  const isTauriMobile = isMobile && isTauri && (os === 'ios' || os === 'android')
  useModalFocus(true, onClose)

  // Focus input on open
  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  // Filter commands by query — memoised so the reference only changes when query changes
  const filtered = useMemo(() => query.trim()
    ? commands.filter((cmd) => {
        const q = query.toLowerCase()
        return (
          cmd.label.toLowerCase().includes(q) ||
          cmd.description?.toLowerCase().includes(q) ||
          cmd.group?.toLowerCase().includes(q)
        )
      })
    : commands,
  // eslint-disable-next-line react-hooks/exhaustive-deps
  [query])

  // Reset active index whenever filtered list changes (query changed)
  const prevQueryRef = useRef(query)
  if (prevQueryRef.current !== query) {
    prevQueryRef.current = query
    // Reset during render — safe because it's gated on a ref change
    if (activeIdx !== 0) setActiveIdx(0)
  }

  // Scroll active item into view
  useEffect(() => {
    const el = listRef.current?.querySelector(`[data-idx="${activeIdx}"]`) as HTMLElement | null
    el?.scrollIntoView({ block: 'nearest' })
  }, [activeIdx])

  const run = useCallback(
    (cmd: Command) => {
      onClose()
      cmd.action()
    },
    [onClose],
  )

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      onClose()
      return
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setActiveIdx((i) => Math.min(i + 1, filtered.length - 1))
      return
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault()
      setActiveIdx((i) => Math.max(i - 1, 0))
      return
    }
    if (e.key === 'Enter') {
      e.preventDefault()
      const cmd = filtered[activeIdx]
      if (cmd) run(cmd)
      return
    }
  }

  // Group commands for display
  const groups = new Map<string, Command[]>()
  for (const cmd of filtered) {
    const g = cmd.group ?? ''
    if (!groups.has(g)) groups.set(g, [])
    groups.get(g)!.push(cmd)
  }

  // Flat list with group headers for rendering (track absolute index)
  type Row = { type: 'header'; label: string } | { type: 'cmd'; cmd: Command; idx: number }
  const rows: Row[] = []
  let absIdx = 0
  for (const [group, cmds] of groups.entries()) {
    if (group) rows.push({ type: 'header', label: group })
    for (const cmd of cmds) {
      rows.push({ type: 'cmd', cmd, idx: absIdx++ })
    }
  }

  return (
    <AnimatePresence>
      <motion.div
        key="backdrop"
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        transition={{ duration: 0.15 }}
        className={`fixed inset-0 z-50 flex items-start justify-center bg-black/60 px-3 backdrop-blur-sm sm:px-0 sm:pt-[15vh] ${isTauriMobile ? 'pt-[max(5rem,calc(env(safe-area-inset-top)+3.5rem))]' : 'pt-4'}`}
        onClick={onClose}
      >
        <motion.div
          key="panel"
          initial={prefersReducedMotion ? { opacity: 0 } : { opacity: 0, scale: 0.97, y: -8 }}
          animate={prefersReducedMotion ? { opacity: 1 } : { opacity: 1, scale: 1, y: 0 }}
          exit={prefersReducedMotion ? { opacity: 0 } : { opacity: 0, scale: 0.97, y: -8 }}
          transition={prefersReducedMotion ? { duration: 0.01 } : { type: 'spring', damping: 30, stiffness: 380 }}
          onClick={(e) => e.stopPropagation()}
          className="flex w-full max-w-md flex-col overflow-hidden rounded-2xl border border-(--color-border) bg-(--bg-card) shadow-2xl"
          role="dialog"
          aria-modal="true"
          aria-label="Command palette"
          data-modal-focus="true"
          onKeyDown={handleKeyDown}
        >
          {/* Search input */}
          <div className="flex items-center gap-3 border-b border-(--color-border) px-4 py-3">
            <Search size={15} className="shrink-0 text-(--color-text-muted)" />
            <input
              ref={inputRef}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search commands…"
              className="flex-1 bg-transparent text-sm text-(--color-text) placeholder-(--color-text-muted) outline-none"
              aria-label="Search commands"
            />
            {query && (
              <button
                onClick={() => setQuery('')}
                className="text-xs text-(--color-text-muted) hover:text-(--color-text-2)"
              >
                Clear
              </button>
            )}
          </div>

          {/* Command list */}
          <div ref={listRef} className="max-h-80 overflow-y-auto py-1.5">
            {filtered.length === 0 ? (
              <p className="px-4 py-6 text-center text-sm text-(--color-text-muted)">
                No commands match "{query}"
              </p>
            ) : (
              rows.map((row, i) => {
                if (row.type === 'header') {
                  return (
                    <p
                      key={`h-${i}`}
                      className="px-4 pb-1 pt-3 text-xs font-semibold uppercase tracking-widest text-(--color-text-muted)"
                    >
                      {row.label}
                    </p>
                  )
                }
                const isActive = row.idx === activeIdx
                return (
                  <CommandRow
                    key={row.cmd.id}
                    cmd={row.cmd}
                    idx={row.idx}
                    isActive={isActive}
                    mouseY={mouseY}
                    onRun={run}
                    onActivate={setActiveIdx}
                  />
                )
              })
            )}
          </div>

          {/* Footer hint */}
          <div className="flex items-center gap-2 border-t border-(--color-border) px-4 py-2">
            <kbd className="rounded border border-(--color-border) bg-(--bg-page) px-1 py-0.5 font-mono text-[10px] text-(--color-text-muted)">↑↓</kbd>
            <span className="text-xs text-(--color-text-muted)">navigate</span>
            <kbd className="rounded border border-(--color-border) bg-(--bg-page) px-1 py-0.5 font-mono text-[10px] text-(--color-text-muted)">↵</kbd>
            <span className="text-xs text-(--color-text-muted)">run</span>
            <kbd className="rounded border border-(--color-border) bg-(--bg-page) px-1 py-0.5 font-mono text-[10px] text-(--color-text-muted)">Esc</kbd>
            <span className="text-xs text-(--color-text-muted)">close</span>
          </div>
        </motion.div>
      </motion.div>
    </AnimatePresence>
  )
}

interface CommandRowProps {
  cmd: Command
  idx: number
  isActive: boolean
  mouseY: number | null
  onRun: (cmd: Command) => void
  onActivate: (idx: number) => void
}

/**
 * Single command row with proximity fade. The keyboard-driven `activeIdx`
 * still owns the dominant `accent-subtle` background; proximity adds a
 * softer `accent-dim` layer on nearby non-active rows so the cursor's
 * position is readable before `onMouseEnter` fires.
 *
 * Layering mirrors SessionRow in Sidebar: proximity is an absolute sibling
 * behind the button (`-z-10`, `isolation: isolate` on wrapper), so the
 * button's own `hover:bg-*` class can still paint on top without being
 * overridden by an inline style on the same element.
 */
function CommandRow({ cmd, idx, isActive, mouseY, onRun, onActivate }: CommandRowProps) {
  const { ref, intensity } = useProximityIntensity(mouseY)
  const showProximity = !isActive && intensity > 0

  return (
    <div ref={ref as React.RefObject<HTMLDivElement>} className="relative isolate">
      {showProximity && (
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0 -z-10"
          style={{
            backgroundColor: `color-mix(in srgb, var(--bg-key) ${intensity * 100}%, transparent)`,
          }}
        />
      )}
      <button
        data-idx={idx}
        onClick={() => onRun(cmd)}
        onMouseEnter={() => onActivate(idx)}
        className={`flex w-full items-center gap-3 px-4 py-2.5 text-left transition-colors ${
          isActive
            ? 'bg-(--bg-key) text-(--color-text)'
            : 'text-(--color-text-2) hover:bg-(--bg-key)'
        }`}
      >
        <div className="min-w-0 flex-1">
          <span className="block text-sm font-medium">{cmd.label}</span>
          {cmd.description && (
            <span className="block truncate text-xs text-(--color-text-muted)">
              {cmd.description}
            </span>
          )}
        </div>
        {cmd.shortcut && (
          <kbd className="shrink-0 rounded border border-(--color-border) bg-(--bg-page) px-1.5 py-0.5 font-mono text-xs text-(--color-text-muted)">
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
