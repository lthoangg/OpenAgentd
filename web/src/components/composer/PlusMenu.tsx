/**
 * PlusMenu — the composer's "+": add things to the message (files, a file
 * mention, a snippet), ask a side question, and the session's MCP servers.
 *
 * MCP lives here rather than in a settings overlay: a server that works needs
 * no attention, and one that does gets the deck's MCP chip, which opens this
 * menu at that section (as does ``/mcp``).
 */
import { useEffect, useRef } from 'react'
import { AtSign, Hash, MessageCircleQuestion, Paperclip, Plus } from 'lucide-react'

import { SessionMcpServers } from '@/components/SessionMcpServers'
import { BottomSheet } from '@/components/ui/bottom-sheet'
import { MENU_ITEM_CLASS, MENU_SEPARATOR_CLASS } from '@/components/ui/menu-styles'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { useIsMobile } from '@/hooks/use-mobile'
import { useAgentsQuery } from '@/queries/useAgentsQuery'
import { cn } from '@/lib/utils'
import { useUIStore } from '@/stores/useUIStore'

/** What the "+" menu can do to the draft; supplied by the composer. */
export interface ComposerActions {
  /** Open the file chooser. */
  attach: () => void
  /** Type ``@`` or ``#`` at the caret and open its picker. */
  startToken: (token: '@' | '#') => void
  /** Replace the draft (``/btw `` for a side question) and focus it. */
  setDraft: (text: string) => void
}

export interface PlusMenuProps {
  actions: ComposerActions
  workspace: string | null
  disabled?: boolean
  /** Side questions answer from the session, so they need one. */
  canAskSideQuestion?: boolean
  /** The agent has snippets to insert. */
  hasSnippets?: boolean
}

export function PlusMenu({ actions, workspace, disabled = false, canAskSideQuestion = false, hasSnippets = true }: PlusMenuProps) {
  const isMobile = useIsMobile()
  const open = useUIStore((s) => s.plusMenuOpen)
  const section = useUIStore((s) => s.plusMenuSection)
  const setOpen = (next: boolean) => {
    const ui = useUIStore.getState()
    if (next) ui.openPlusMenu()
    else ui.closePlusMenu()
  }
  const run = (fn: () => void) => () => {
    setOpen(false)
    // After the menu has handed focus back, so the action keeps it.
    requestAnimationFrame(fn)
  }

  const trigger = (
    <button
      type="button"
      disabled={disabled}
      aria-label="Add to message"
      aria-haspopup="dialog"
      onClick={isMobile ? () => setOpen(!open) : undefined}
      className="flex size-8 shrink-0 items-center justify-center rounded-md text-(--color-text-muted) transition-colors duration-(--motion-instant) hover:bg-(--bg-key) hover:text-(--color-text) aria-expanded:bg-(--bg-key) aria-expanded:text-(--color-text) focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-(--focus-ring) disabled:cursor-not-allowed disabled:opacity-50 md:size-7 pointer-coarse:size-9"
    >
      <Plus size={15} aria-hidden="true" />
    </button>
  )

  const content = (
    <PlusMenuItems
      touch={isMobile}
      workspace={workspace}
      scrollToMcp={section === 'mcp'}
      onAttach={run(actions.attach)}
      onMention={run(() => actions.startToken('@'))}
      onSnippet={hasSnippets ? run(() => actions.startToken('#')) : undefined}
      onSideQuestion={canAskSideQuestion ? run(() => actions.setDraft('/btw ')) : undefined}
    />
  )

  if (isMobile) {
    return (
      <>
        {trigger}
        <BottomSheet open={open} onClose={() => setOpen(false)} label="Add to message">
          <div className="px-2 pb-3">{content}</div>
        </BottomSheet>
      </>
    )
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger render={trigger} />
      <PopoverContent side="top" align="start" sideOffset={8} role="dialog" aria-label="Add to message" className="w-[min(22rem,calc(100vw-1rem))] gap-0 p-1">
        {content}
      </PopoverContent>
    </Popover>
  )
}

function PlusMenuItems({
  touch,
  workspace,
  scrollToMcp,
  onAttach,
  onMention,
  onSnippet,
  onSideQuestion,
}: {
  touch: boolean
  workspace: string | null
  scrollToMcp: boolean
  onAttach: () => void
  onMention: () => void
  onSnippet?: () => void
  onSideQuestion?: () => void
}) {
  const agents = useAgentsQuery(workspace, Boolean(workspace))
  const agentServers = agents.data?.agents?.[0]?.mcp_servers ?? []
  const mcpRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (scrollToMcp) mcpRef.current?.scrollIntoView({ block: 'nearest' })
  }, [scrollToMcp])
  const row = cn(MENU_ITEM_CLASS, touch && 'min-h-11 text-sm')
  const hint = 'ml-auto font-mono text-meta text-(--color-text-muted)'
  return (
    <div className="flex flex-col">
      <button type="button" className={row} onClick={onAttach}>
        <Paperclip size={14} aria-hidden="true" />
        Attach files…
      </button>
      <button type="button" className={row} onClick={onMention}>
        <AtSign size={14} aria-hidden="true" />
        Mention a file
        <span className={hint}>@</span>
      </button>
      {onSnippet && (
        <button type="button" className={row} onClick={onSnippet}>
          <Hash size={14} aria-hidden="true" />
          Insert a snippet
          <span className={hint}>#</span>
        </button>
      )}
      {onSideQuestion && (
        <button type="button" className={row} onClick={onSideQuestion}>
          <MessageCircleQuestion size={14} aria-hidden="true" />
          Ask a side question
          <span className={hint}>/btw</span>
        </button>
      )}
      <div className={MENU_SEPARATOR_CLASS} role="separator" />
      <div ref={mcpRef}>
        <SessionMcpServers
          variant="menu"
          agentServers={agentServers}
          onServersChanged={() => { void agents.refetch() }}
        />
      </div>
    </div>
  )
}
