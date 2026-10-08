/**
 * Design comments in the Preview tab: the composer anchored under a picked
 * element and the numbered list with **Send to agent**.
 */
import { useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react'
import { Pencil, Send, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { PREVIEW_COMMENT_MAX_CHARS, elementLabel, type PreviewComment } from './preview-comments'
import type { ElementDescriptor } from './preview-protocol'

export const COMPOSER_WIDTH = 288

export interface ComposerAnchor {
  top: number
  left: number
}

export function PreviewCommentComposer({
  element,
  anchor,
  bounds,
  onAdd,
  onCancel,
}: {
  element: ElementDescriptor
  /** Stage-relative point under the element. */
  anchor: ComposerAnchor
  /** Stage size, to keep the composer inside it. */
  bounds: { width: number; height: number }
  onAdd: (text: string) => void
  onCancel: () => void
}) {
  const [text, setText] = useState('')
  const ref = useRef<HTMLDivElement>(null)
  const [height, setHeight] = useState(150)
  useLayoutEffect(() => {
    const h = ref.current?.offsetHeight
    if (h && h !== height) setHeight(h)
  }, [height, text])
  const width = Math.min(COMPOSER_WIDTH, Math.max(160, bounds.width - 16))
  const left = Math.max(8, Math.min(anchor.left, bounds.width - width - 8))
  const top = Math.max(8, Math.min(anchor.top, bounds.height - height - 8))

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault()
      onCancel()
    } else if (event.key === 'Enter' && (event.metaKey || event.ctrlKey) && text.trim()) {
      event.preventDefault()
      onAdd(text.trim())
    }
  }

  return (
    <div
      ref={ref}
      role="group"
      aria-label="New design comment"
      className="shadow-(--shadow-depth) absolute z-20 rounded-sm border border-(--color-border) bg-(--bg-card) p-2"
      style={{ top, left, width }}
    >
      <p className="mb-1.5 truncate border-l-2 border-(--color-border-strong) pl-2 font-mono text-[11px] leading-relaxed text-(--color-text-subtle)">
        {elementLabel(element)}
        {element.text ? ` ${element.text}` : ''}
      </p>
      <Textarea
        autoFocus
        aria-label="Comment"
        placeholder="What should change here?"
        value={text}
        maxLength={PREVIEW_COMMENT_MAX_CHARS}
        onChange={(event) => setText(event.target.value)}
        onKeyDown={onKeyDown}
        className="max-h-40 min-h-16 text-xs"
      />
      <div className="mt-1.5 flex items-center justify-end gap-1.5">
        <Button type="button" variant="ghost" size="xs" className="pointer-coarse:h-11" onClick={onCancel}>
          Cancel
        </Button>
        <Button type="button" variant="primary" size="xs" className="pointer-coarse:h-11" onClick={() => onAdd(text.trim())} disabled={!text.trim()}>
          Add comment
        </Button>
      </div>
    </div>
  )
}

export function PreviewCommentList({
  comments,
  onRemove,
  onEdit,
  onClear,
  onSend,
}: {
  comments: readonly PreviewComment[]
  onRemove: (id: string) => void
  onEdit: (id: string, text: string) => void
  onClear: () => void
  onSend: () => void
}) {
  const [editing, setEditing] = useState<{ id: string; text: string } | null>(null)
  const save = () => {
    if (editing && editing.text.trim()) onEdit(editing.id, editing.text.trim())
    setEditing(null)
  }
  return (
    <section aria-label="Design comments" className="shrink-0 border-t border-(--color-border) bg-(--bg-page)">
      <div className="flex h-(--spacing-toolbar) items-center gap-2 pr-1 pl-3">
        <p className="min-w-0 flex-1 truncate text-xs text-(--color-text-muted)">
          {comments.length} {comments.length === 1 ? 'comment' : 'comments'}
        </p>
        <Button type="button" variant="ghost" size="xs" className="pointer-coarse:h-11" onClick={onClear}>
          Clear
        </Button>
        <Button type="button" variant="primary" size="xs" className="gap-1 pointer-coarse:h-11" onClick={onSend}>
          <Send size={11} aria-hidden="true" />
          Send to agent ({comments.length})
        </Button>
      </div>
      <ul className="max-h-36 space-y-1 overflow-y-auto overscroll-contain px-2 pb-2">
        {comments.map((comment) => (
          <li key={comment.id} className="flex items-start gap-2 rounded-sm border border-(--color-border-subtle) bg-(--bg-input) py-1 pr-1 pl-1.5">
            <span className="mt-0.5 flex h-4 min-w-4 shrink-0 items-center justify-center rounded-full bg-(--color-accent) px-1 text-[11px] font-semibold text-(--color-text-on-accent)">
              {comment.n}
            </span>
            <div className="min-w-0 flex-1">
              <p className="truncate font-mono text-[11px] text-(--color-text-subtle)">{elementLabel(comment.element)} {comment.element.text}</p>
              {editing?.id === comment.id ? (
                <div className="mt-1">
                  <Textarea
                    autoFocus
                    aria-label={`Edit comment ${comment.n}`}
                    value={editing.text}
                    maxLength={PREVIEW_COMMENT_MAX_CHARS}
                    onChange={(event) => setEditing({ id: comment.id, text: event.target.value })}
                    onKeyDown={(event) => {
                      if (event.key === 'Escape') {
                        event.preventDefault()
                        setEditing(null)
                      } else if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
                        event.preventDefault()
                        save()
                      }
                    }}
                    className="max-h-32 min-h-12 text-xs"
                  />
                  <div className="mt-1 flex justify-end gap-1.5">
                    <Button type="button" variant="ghost" size="xs" className="pointer-coarse:h-11" aria-label="Cancel edit" onClick={() => setEditing(null)}>
                      Cancel
                    </Button>
                    <Button type="button" variant="primary" size="xs" className="pointer-coarse:h-11" onClick={save} disabled={!editing.text.trim()}>
                      Save
                    </Button>
                  </div>
                </div>
              ) : (
                <p className="mt-0.5 line-clamp-3 text-xs leading-relaxed break-words whitespace-pre-wrap text-(--color-text)">{comment.text}</p>
              )}
            </div>
            {editing?.id !== comment.id && (
              <Button type="button" variant="ghost" size="icon-xs" className="pointer-coarse:size-11" aria-label={`Edit comment ${comment.n}`} onClick={() => setEditing({ id: comment.id, text: comment.text })}>
                <Pencil size={11} aria-hidden="true" />
              </Button>
            )}
            <Button type="button" variant="ghost" size="icon-xs" className="pointer-coarse:size-11" aria-label={`Remove comment ${comment.n}`} onClick={() => onRemove(comment.id)}>
              <X size={11} aria-hidden="true" />
            </Button>
          </li>
        ))}
      </ul>
    </section>
  )
}
