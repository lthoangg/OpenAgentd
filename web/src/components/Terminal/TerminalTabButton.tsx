/**
 * TerminalTabButton — tab chip for a terminal session in
 * CodingWorkspacePanel (terminal is coding-mode only for now).
 *
 * Desktop: right-click opens a small menu (Rename / Close).
 * Mobile: long-press opens the same choice as a bottom sheet — no native
 * context menu on touch, matching the LongPressButton pattern used
 * elsewhere (Sidebar sessions, changed-files, commits).
 * Both funnel into useTerminalStore.rename() / .close().
 */

import { useRef, useState } from 'react'
import { Pencil, TerminalSquare, X } from 'lucide-react'

import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { LongPressButton } from '@/components/ui/long-press-button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { softHapticFeedback } from '@/lib/haptics'
import { cn } from '@/lib/utils'
import { useTerminalStore, type TerminalSessionMeta } from '@/stores/useTerminalStore'

interface TerminalTabButtonProps {
  meta: TerminalSessionMeta
  active: boolean
  mobile: boolean
  onActivate: () => void
  className?: string
  buttonRef?: (node: HTMLButtonElement | null) => void
}

export function TerminalTabButton({
  meta,
  active,
  mobile,
  onActivate,
  className,
  buttonRef,
}: TerminalTabButtonProps) {
  const [desktopMenuAt, setDesktopMenuAt] = useState<{ x: number; y: number } | null>(null)
  const [mobileSheetOpen, setMobileSheetOpen] = useState(false)
  const [renaming, setRenaming] = useState(false)
  const [draftTitle, setDraftTitle] = useState(meta.title)
  const renameInputRef = useRef<HTMLInputElement>(null)

  const openRename = () => {
    setDraftTitle(meta.title)
    setRenaming(true)
  }

  const submitRename = (e: React.FormEvent) => {
    e.preventDefault()
    useTerminalStore.getState().rename(meta.id, draftTitle)
    setRenaming(false)
  }

  return (
    <>
      {/* Background/border live on this wrapper (not the inner button) so
          the inline close control sits in the same flex row as the label —
          matching the file-tab layout — instead of floating over truncated
          text via absolute positioning. */}
      <div
        className={cn(
          'group flex h-7 max-w-40 shrink-0 items-center gap-0.5 rounded-xs pl-2 text-xs',
          mobile && 'pr-2',
          active
            ? 'border border-(--color-border-strong) bg-(--bg-key)/35 text-(--color-text)'
            : 'border border-transparent text-(--color-text-muted) hover:text-(--color-text-2)',
          className,
        )}
      >
        <Tooltip className="min-w-0 flex-1">
          <TooltipTrigger
            className="min-w-0 flex-1"
            render={
              <LongPressButton
                ref={buttonRef}
                type="button"
                enabled={mobile}
                onLongPress={() => {
                  softHapticFeedback()
                  setMobileSheetOpen(true)
                }}
                onContextMenu={(e) => {
                  if (mobile) return
                  e.preventDefault()
                  setDesktopMenuAt({ x: e.clientX, y: e.clientY })
                }}
                onClick={onActivate}
                className="flex min-w-0 flex-1 items-center gap-1.5 truncate"
              >
                <TerminalSquare size={12} className="shrink-0" aria-hidden="true" />
                <span className="truncate font-mono">{meta.title}</span>
              </LongPressButton>
            }
          />
          <TooltipContent>{meta.title}</TooltipContent>
        </Tooltip>
        {!mobile && (
          <span
            role="button"
            tabIndex={0}
            onClick={(e) => {
              e.stopPropagation()
              useTerminalStore.getState().close(meta.id)
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault()
                e.stopPropagation()
                useTerminalStore.getState().close(meta.id)
              }
            }}
            className="ml-0.5 shrink-0 rounded p-0.5 text-(--color-text-subtle) opacity-70 hover:text-(--color-text) md:opacity-0 md:group-hover:opacity-100 md:group-focus-within:opacity-100"
            aria-label={`Close ${meta.title}`}
          >
            <X size={11} aria-hidden="true" />
          </span>
        )}
      </div>

      {/* Desktop: right-click menu */}
      {desktopMenuAt && (
        <div
          className="fixed inset-0 z-50"
          onClick={() => setDesktopMenuAt(null)}
          onContextMenu={(e) => { e.preventDefault(); setDesktopMenuAt(null) }}
        >
          <div
            role="menu"
            aria-label={`Actions for ${meta.title}`}
            className="fixed min-w-40 rounded-sm border border-(--color-border) bg-(--bg-card) p-1 text-xs text-(--color-text) shadow-md"
            style={{
              left: Math.min(desktopMenuAt.x, window.innerWidth - 170 - 8),
              top: Math.min(desktopMenuAt.y, window.innerHeight - 90 - 8),
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <button
              type="button"
              role="menuitem"
              className="flex w-full items-center gap-2 rounded-xs px-2 py-1 text-left text-xs hover:bg-(--bg-key) focus-visible:bg-(--bg-key) focus-visible:outline-none"
              onClick={() => { setDesktopMenuAt(null); openRename() }}
            >
              <Pencil size={12} aria-hidden="true" />
              Rename
            </button>
            <button
              type="button"
              role="menuitem"
              className="flex w-full items-center gap-2 rounded-xs px-2 py-1 text-left text-xs text-(--color-error) hover:bg-(--color-error-subtle) focus-visible:bg-(--color-error-subtle) focus-visible:outline-none"
              onClick={() => {
                setDesktopMenuAt(null)
                useTerminalStore.getState().close(meta.id)
              }}
            >
              <X size={12} aria-hidden="true" />
              Close
            </button>
          </div>
        </div>
      )}

      {/* Mobile: long-press action sheet */}
      <Dialog open={mobileSheetOpen} onOpenChange={setMobileSheetOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="truncate">{meta.title}</DialogTitle>
            <DialogDescription>Choose a terminal action.</DialogDescription>
          </DialogHeader>
          <DialogFooter className="flex-col items-stretch gap-2 p-3 sm:flex-col">
            <Button
              type="button"
              variant="ghost"
              className="justify-start"
              onClick={() => { setMobileSheetOpen(false); openRename() }}
            >
              <Pencil size={14} aria-hidden="true" />
              Rename
            </Button>
            <Button
              type="button"
              variant="danger-subtle"
              className="justify-start"
              onClick={() => {
                setMobileSheetOpen(false)
                useTerminalStore.getState().close(meta.id)
              }}
              aria-label="Close terminal"
            >
              <X size={14} aria-hidden="true" />
              Close terminal
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Shared rename dialog (desktop menu + mobile sheet both open it) */}
      <Dialog
        open={renaming}
        onOpenChange={(open) => {
          setRenaming(open)
          if (open) window.setTimeout(() => renameInputRef.current?.select(), 0)
        }}
      >
        <DialogContent showCloseButton={false}>
          <form onSubmit={submitRename}>
            <DialogHeader>
              <DialogTitle>Rename terminal</DialogTitle>
              <DialogDescription>Give this session a memorable name.</DialogDescription>
            </DialogHeader>
            <div className="px-3 py-2">
              <Input
                ref={renameInputRef}
                value={draftTitle}
                onChange={(e) => setDraftTitle(e.target.value)}
                aria-label="Terminal name"
                maxLength={64}
                autoFocus
              />
            </div>
            <DialogFooter className="p-3">
              <Button type="button" variant="default" onClick={() => setRenaming(false)}>
                Cancel
              </Button>
              <Button type="submit" disabled={!draftTitle.trim()}>
                Save
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </>
  )
}
