/**
 * TerminalTextView — Select Text: the terminal's output as ordinary text.
 *
 * xterm.js selects only with a mouse, so on a phone or tablet a drag scrolls
 * and only Select All works. This view, opened from the long-press menu,
 * lays the scrollback out as text (``.selectable-text``) where the platform's
 * own selection works: handles, the magnifier, word snapping, the system
 * Copy. The bar adds Copy and Add to chat for the current selection; Done
 * goes back to the live terminal. It is a snapshot: output that arrives
 * while it is open shows after Done.
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Copy, MessageSquarePlus } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { useCopyFeedback } from '@/hooks/use-copy-feedback'
import { requestComposerInsert } from '@/lib/composer-insert'
import { formatTerminalSelection } from './terminal-actions'
import type { TerminalText } from './terminal-text'

interface TerminalTextViewProps {
  text: TerminalText
  fontFamily: string
  fontSize: number
  onClose: () => void
}

/** The selected text when the selection lies inside ``root``, else ``''``. */
function selectionWithin(root: HTMLElement | null): string {
  const selection = typeof window.getSelection === 'function' ? window.getSelection() : null
  if (!root || !selection || selection.isCollapsed || selection.rangeCount === 0) return ''
  const range = selection.getRangeAt(0)
  if (!root.contains(range.commonAncestorContainer)) return ''
  return selection.toString()
}

export function TerminalTextView({ text, fontFamily, fontSize, onClose }: TerminalTextViewProps) {
  const scrollRef = useRef<HTMLDivElement>(null)
  const textRef = useRef<HTMLDivElement>(null)
  const [selected, setSelected] = useState('')
  const { copied, copy } = useCopyFeedback()
  const lineHeight = Math.round(fontSize * 1.35)

  // Open on the lines the terminal was showing, not at the top of 5000.
  useLayoutEffect(() => {
    const line = textRef.current?.querySelector<HTMLElement>(`[data-line="${text.viewportLine}"]`)
    if (scrollRef.current && line) scrollRef.current.scrollTop = line.offsetTop
  }, [text])

  useEffect(() => {
    const update = () => setSelected(selectionWithin(textRef.current))
    document.addEventListener('selectionchange', update)
    return () => document.removeEventListener('selectionchange', update)
  }, [])

  const onCopy = useCallback(() => {
    const value = selectionWithin(textRef.current)
    if (value) void copy(value)
  }, [copy])

  const onAddToChat = useCallback(() => {
    const block = formatTerminalSelection(selectionWithin(textRef.current))
    if (!block) return
    requestComposerInsert(block)
    window.getSelection()?.removeAllRanges()
    onClose()
  }, [onClose])

  return (
    <div
      role="region"
      aria-label="Terminal text"
      className="absolute inset-0 z-30 flex flex-col bg-(--color-surface)"
      data-swipe-ignore
    >
      <div className="flex shrink-0 items-center justify-between gap-2 border-b border-(--color-border) px-2 py-1.5">
        <Button type="button" variant="ghost" onClick={onClose}>
          Done
        </Button>
        <div className="flex items-center gap-2">
          <Button
            type="button"
            disabled={!selected}
            // Keep the selection: a press must not collapse it before the click.
            onPointerDown={(event) => event.preventDefault()}
            onClick={onCopy}
          >
            <Copy aria-hidden="true" />
            {copied ? 'Copied' : 'Copy'}
          </Button>
          <Button
            type="button"
            variant="primary"
            disabled={!selected}
            onPointerDown={(event) => event.preventDefault()}
            onClick={onAddToChat}
          >
            <MessageSquarePlus aria-hidden="true" />
            Add to chat
          </Button>
        </div>
      </div>
      <div ref={scrollRef} className="min-h-0 flex-1 overflow-auto overscroll-contain p-2">
        <div
          ref={textRef}
          data-testid="terminal-text"
          className="selectable-text whitespace-pre-wrap break-all text-(--color-text)"
          style={{ fontFamily, fontSize, lineHeight: `${lineHeight}px` }}
        >
          {text.lines.map((line, index) => (
            // Index keys: a snapshot never reorders.
            <div key={index} data-line={index} style={{ minHeight: lineHeight }}>
              {line}
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
