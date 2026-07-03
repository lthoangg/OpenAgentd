/**
 * TerminalPanel — cockpit (normal-mode) terminal host.
 *
 * Right-side panel with a tab strip over store-backed terminal sessions
 * keyed `session:{chatSessionId}`. The PTY cwd is the per-session
 * workspace (`{OPENAGENTD_WORKSPACE_DIR}/{sid}`), derived server-side
 * from the session id — the client never sends a path in this mode.
 *
 * Sessions live in `useTerminalStore` and survive closing this panel;
 * the store's idle reaper closes detached sessions after 15 minutes
 * without input. Layout mirrors WorkspaceFilesPanel: desktop renders an
 * in-flow push panel (flex sibling of <main>), mobile a fixed overlay.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { Plus, TerminalSquare, X } from 'lucide-react'
import { TerminalTabButton } from './TerminalTabButton'

import { useIsMobile } from '@/hooks/use-mobile'
import { useReducedMotion } from '@/hooks/useReducedMotion'
import { useResizableWidth } from '@/hooks/use-resizable-width'
import { useTerminalStore } from '@/stores/useTerminalStore'
import { TerminalView } from './TerminalView'

const DEFAULT_WIDTH = 480
const MIN_WIDTH = 320
const MAX_WIDTH = 900

interface TerminalPanelProps {
  open: boolean
  sessionId: string
  /** Bump to open (or focus) a terminal — ⌘⇧` / palette. 0 is ignored. */
  openKey?: number
  onClose: () => void
}

export function TerminalPanel({ open, sessionId, openKey = 0, onClose }: TerminalPanelProps) {
  const isMobile = useIsMobile()
  const prefersReducedMotion = useReducedMotion()
  const contextKey = `session:${sessionId}`

  const sessions = useTerminalStore((s) => s.sessions)
  const metas = useMemo(
    () =>
      Object.values(sessions)
        .filter((meta) => meta.contextKey === contextKey)
        .sort((a, b) => a.order - b.order),
    [sessions, contextKey],
  )

  // Active tab: last selected if still present, else the most recent session.
  const [activeId, setActiveId] = useState<string | null>(null)
  const activeMeta =
    metas.find((m) => m.id === activeId) ?? metas[metas.length - 1] ?? null

  const openTerminal = useCallback(() => {
    setActiveId(useTerminalStore.getState().open({ sessionId }, contextKey))
  }, [sessionId, contextKey])

  // Parent-driven open requests — bump-key pattern (see CodingWorkspacePanel):
  // focus the latest terminal, or open the first one.
  const handledOpenKeyRef = useRef(0)
  useEffect(() => {
    if (openKey > handledOpenKeyRef.current) {
      handledOpenKeyRef.current = openKey
      const existing = useTerminalStore.getState().sessionsForContext(contextKey)
      if (existing.length === 0) openTerminal()
      else setActiveId(existing[existing.length - 1].id)
    }
  }, [openKey, contextKey, openTerminal])

  const resizable = useResizableWidth({
    storageKey: 'oa.terminalPanel.width',
    defaultWidth: DEFAULT_WIDTH,
    minWidth: MIN_WIDTH,
    maxWidth: MAX_WIDTH,
    edge: 'left',
    disabled: isMobile,
  })

  // Escape closes — mobile overlay only (desktop panel has no backdrop).
  useEffect(() => {
    if (!open || !isMobile) return
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [open, isMobile, onClose])

  const panelContent = (
    <div className="relative flex h-full min-h-0 w-full flex-col">
      {!isMobile && (
        <div
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize terminal panel"
          title="Drag to resize · double-click to reset"
          className="absolute left-0 top-0 z-10 h-full w-1 cursor-col-resize transition-colors hover:bg-(--color-accent)/40"
          onPointerDown={resizable.startResize}
          onDoubleClick={resizable.resetWidth}
        />
      )}

      {/* Header: tab strip + actions */}
      <header className="flex shrink-0 items-center gap-1 border-b border-(--color-border) bg-(--bg-card) px-2 py-1">
        <div className="scrollbar-none flex min-w-0 flex-1 items-center gap-1 overflow-x-auto">
          {metas.map((meta) => (
            <TerminalTabButton
              key={meta.id}
              meta={meta}
              active={activeMeta?.id === meta.id}
              mobile={isMobile}
              onActivate={() => { setActiveId(meta.id); useTerminalStore.getState().noteActivity(meta.id) }}
            />
          ))}
        </div>
        <button
          type="button"
          onClick={openTerminal}
          className="flex h-8 w-8 shrink-0 items-center justify-center rounded-sm text-(--color-text-muted) hover:bg-(--bg-key) hover:text-(--color-text) md:h-7 md:w-7"
          aria-label="New terminal"
          title="New terminal"
        >
          <Plus size={14} aria-hidden="true" />
        </button>
        <button
          type="button"
          onClick={onClose}
          className="flex h-8 w-8 shrink-0 items-center justify-center rounded-sm text-(--color-text-muted) hover:bg-(--bg-key) hover:text-(--color-text) md:h-7 md:w-7"
          aria-label="Close terminal panel"
          title="Close panel — terminals keep running"
        >
          <X size={14} aria-hidden="true" />
        </button>
      </header>

      {/* Body — only the active terminal is mounted; hidden sessions keep
          their PTY + scrollback in the store. */}
      <div className="min-h-0 flex-1 overflow-hidden p-1.5">
        {activeMeta ? (
          <TerminalView key={activeMeta.id} sessionId={activeMeta.id} />
        ) : (
          <div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center">
            <TerminalSquare size={24} className="text-(--color-text-subtle)" aria-hidden="true" />
            <p className="text-sm text-(--color-text-2)">No terminal open</p>
            <p className="max-w-xs text-xs text-(--color-text-subtle)">
              Runs in this session&apos;s workspace on the connected server.
            </p>
          </div>
        )}
      </div>
    </div>
  )

  // Desktop: in-flow push panel (flex sibling of <main>).
  if (!isMobile) {
    return (
      <AnimatePresence>
        {open && (
          <motion.aside
            key="terminal-panel"
            role="complementary"
            aria-label="Terminal"
            initial={prefersReducedMotion ? { opacity: 0 } : { width: 0, opacity: 0 }}
            animate={prefersReducedMotion ? { opacity: 1 } : { width: resizable.width, opacity: 1 }}
            exit={prefersReducedMotion ? { opacity: 0 } : { width: 0, opacity: 0 }}
            transition={{ duration: resizable.isResizing || prefersReducedMotion ? 0.01 : 0.22, ease: [0.4, 0, 0.2, 1] }}
            className="h-full shrink-0 overflow-hidden border-l border-(--color-border) bg-(--bg-page)"
          >
            {panelContent}
          </motion.aside>
        )}
      </AnimatePresence>
    )
  }

  // Mobile: fixed overlay from the right, below the app header.
  return (
    <AnimatePresence>
      {open && (
        <>
          <motion.div
            key="terminal-backdrop"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.15 }}
            className="mobile-safe-top fixed inset-x-0 bottom-0 z-40 bg-black/30"
            onClick={onClose}
            aria-hidden="true"
            data-swipe-ignore
          />
          <motion.aside
            key="terminal-panel"
            role="dialog"
            aria-modal="true"
            aria-label="Terminal"
            initial={prefersReducedMotion ? { opacity: 0 } : { x: '100%' }}
            animate={prefersReducedMotion ? { opacity: 1 } : { x: 0 }}
            exit={prefersReducedMotion ? { opacity: 0 } : { x: '100%' }}
            transition={{ duration: prefersReducedMotion ? 0.01 : 0.22, ease: [0.4, 0, 0.2, 1] }}
            className="mobile-safe-top fixed inset-x-0 bottom-0 z-50 overflow-hidden border-t border-(--color-border) bg-(--bg-page) shadow-xl"
            data-swipe-ignore
          >
            {panelContent}
          </motion.aside>
        </>
      )}
    </AnimatePresence>
  )
}
