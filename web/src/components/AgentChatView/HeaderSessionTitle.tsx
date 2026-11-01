/**
 * HeaderSessionTitle — the session's name in the desktop header. With a
 * rename handler it is a button: double-click it, or press F2 while it has
 * focus, and it turns into a text field in place (Enter or leaving the field
 * saves; Escape, an empty or an unchanged title cancels). Without one (a
 * subagent's session, which the sidebar does not rename either) it is plain
 * text. Phones rename from the drawer, so they never render this.
 *
 * The caller owns the mutation, so the sidebar and header share one path.
 */
import { useEffect, useRef, useState } from 'react'

import { AnimatedTitle } from '@/components/ui/animated-title'
import { InlineTitleInput } from '@/components/ui/inline-title-input'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { isRenameKey } from '@/lib/focus/item-keys'

interface HeaderSessionTitleProps {
  sessionId: string | null
  title: string
  /** Saves a new, trimmed title. Omit to show the title read-only. */
  onRename?: (title: string) => void
}

export function HeaderSessionTitle({ sessionId, title, onRename }: HeaderSessionTitleProps) {
  return onRename ? (
    <RenameableTitle sessionId={sessionId} title={title} onRename={onRename} />
  ) : (
    <Tooltip className="min-w-0">
      <TooltipTrigger
        className="min-w-0"
        render={
          <span className="flex min-w-0 text-(--color-text-muted)">
            <AnimatedTitle text={title} sessionId={sessionId} />
          </span>
        }
      />
      <TooltipContent>{title}</TooltipContent>
    </Tooltip>
  )
}

function RenameableTitle({ sessionId, title, onRename }: HeaderSessionTitleProps & { onRename: (title: string) => void }) {
  const [editing, setEditing] = useState(false)
  const buttonRef = useRef<HTMLButtonElement>(null)
  // Enter and Escape hand focus back to the title; leaving by click or Tab
  // keeps it wherever the user sent it.
  const refocus = useRef(false)

  useEffect(() => {
    if (editing || !refocus.current) return
    refocus.current = false
    buttonRef.current?.focus()
  }, [editing])

  if (editing) {
    return (
      <span
        className="flex min-w-0 items-center"
        onKeyDownCapture={(event) => {
          if (event.key === 'Enter' || event.key === 'Escape') refocus.current = true
        }}
      >
        <InlineTitleInput
          variant="field"
          initial={title}
          label="Session title"
          onSubmit={(next) => {
            setEditing(false)
            onRename(next)
          }}
          onCancel={() => setEditing(false)}
          // Inherits the title's font and size from the header.
          className="h-6 w-56 max-w-full lg:w-72"
        />
      </span>
    )
  }

  return (
    <Tooltip className="min-w-0">
      <TooltipTrigger
        className="min-w-0"
        render={
          <button
            ref={buttonRef}
            type="button"
            aria-label={`Rename session: ${title}`}
            // Enter or Space (a click with no pointer, detail 0) renames, so
            // the button does what its name says from the keyboard too; a
            // single mouse click does not, so a stray click keeps the title.
            onClick={(event) => { if (event.detail === 0) setEditing(true) }}
            onDoubleClick={() => setEditing(true)}
            onKeyDown={(event) => {
              if (!isRenameKey(event)) return
              event.preventDefault()
              setEditing(true)
            }}
            className="flex min-w-0 rounded-xs text-left text-(--color-text-muted) focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-(--focus-ring) pointer-coarse:h-9"
          >
            <AnimatedTitle text={title} sessionId={sessionId} />
          </button>
        }
      />
      <TooltipContent>
        <span className="block">{title}</span>
        <span className="block">Double-click to rename</span>
      </TooltipContent>
    </Tooltip>
  )
}
