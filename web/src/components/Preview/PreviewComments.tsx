/**
 * Comments in the Preview tab: the composer anchored under a picked
 * element and the numbered list with **Send to agent**.
 */
import { useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react'
import { ChevronDown, ChevronUp, Pencil, Send } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { CloseButton } from '@/components/ui/close-button'
import { Textarea } from '@/components/ui/textarea'
import { usePlatform } from '@/hooks/use-platform'
import { cn } from '@/lib/utils'
import { formatChord } from '@/lib/keyboard/chord'
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
  /**
   * Stage-relative point under the element. Without one the composer is a
   * block in the page's flow: over a native view (a public site) nothing of
   * the app can float.
   */
  anchor?: ComposerAnchor | null
  /** Stage size, to keep an anchored composer inside it. */
  bounds?: { width: number; height: number }
  onAdd: (text: string) => void
  onCancel: () => void
}) {
  const [text, setText] = useState('')
  const { os } = usePlatform()
  const ref = useRef<HTMLDivElement>(null)
  const [height, setHeight] = useState(150)
  useLayoutEffect(() => {
    const h = ref.current?.offsetHeight
    if (h && h !== height) setHeight(h)
  }, [height, text])
  const box = bounds ?? { width: COMPOSER_WIDTH + 16, height: height + 16 }
  const width = Math.min(COMPOSER_WIDTH, Math.max(160, box.width - 16))
  const left = Math.max(8, Math.min(anchor?.left ?? 8, box.width - width - 8))
  const top = Math.max(8, Math.min(anchor?.top ?? 8, box.height - height - 8))

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
      aria-label="New comment"
      className={cn('rounded-sm border border-(--color-border) bg-(--bg-card) p-2', anchor ? 'shadow-(--shadow-depth) absolute z-20' : 'm-2 max-w-md shrink-0')}
      style={anchor ? { top, left, width } : undefined}
    >
      <p className="mb-1.5 truncate border-l-2 border-(--color-border-strong) pl-2 font-mono text-meta leading-relaxed text-(--color-text-subtle)">
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
        <Button type="button" variant="ghost" size="xs" className="pointer-coarse:h-9" onClick={onCancel}>
          Cancel
        </Button>
        <Button type="button" variant="primary" size="xs" className="gap-1.5 pointer-coarse:h-9" onClick={() => onAdd(text.trim())} disabled={!text.trim()}>
          Add comment
          {/* The keys that add it from the box; no keyboard to press them on, on touch. */}
          <kbd aria-hidden="true" className="font-sans text-meta font-normal opacity-70 pointer-coarse:hidden">{formatChord({ key: 'Enter', mod: true }, os)}</kbd>
        </Button>
      </div>
    </div>
  )
}

export function PreviewCommentList({
  comments,
  phone = false,
  onRemove,
  onEdit,
  onClear,
  onSend,
  onShow,
}: {
  comments: readonly PreviewComment[]
  /** A phone keeps the page its room: the list is one row until it is opened. */
  phone?: boolean
  onRemove: (id: string) => void
  onEdit: (id: string, text: string) => void
  onClear: () => void
  onSend: () => void
  /** Bring a comment's pin into view on the page. */
  onShow: (n: number) => void
}) {
  const [editing, setEditing] = useState<{ id: string; text: string } | null>(null)
  const [opened, setOpened] = useState(false)
  const open = !phone || opened
  const count = `${comments.length} ${comments.length === 1 ? 'comment' : 'comments'}`
  const save = () => {
    if (editing && editing.text.trim()) onEdit(editing.id, editing.text.trim())
    setEditing(null)
  }
  return (
    <section aria-label="Comments" className="shrink-0 border-t border-(--color-border) bg-(--bg-page)">
      {/* A phone's 36px buttons need a taller row than the toolbar step. */}
      <div className={cn('flex items-center gap-2 pr-1 pl-3', phone ? 'min-h-11 py-1' : 'h-(--spacing-toolbar)')}>
        {phone ? (
          <button
            type="button"
            aria-expanded={opened}
            onClick={() => setOpened((value) => !value)}
            className="flex min-h-9 min-w-0 flex-1 items-center gap-1 text-left text-xs text-(--color-text-muted)"
          >
            <span className="truncate">{count}</span>
            {opened ? <ChevronDown size={14} aria-hidden="true" /> : <ChevronUp size={14} aria-hidden="true" />}
          </button>
        ) : (
          <p className="min-w-0 flex-1 truncate text-xs text-(--color-text-muted)">{count}</p>
        )}
        {open && (
          <Button type="button" variant="ghost" size="xs" className="pointer-coarse:h-9" onClick={onClear}>
            Clear
          </Button>
        )}
        <Button type="button" variant="primary" size="xs" className="gap-1 pointer-coarse:h-9" onClick={onSend}>
          <Send size={12} aria-hidden="true" />
          Send to agent ({comments.length})
        </Button>
      </div>
      {open && (
      <ul className="max-h-36 space-y-1 overflow-y-auto overscroll-contain px-2 pb-2">
        {comments.map((comment) => (
          <li key={comment.id} className="flex items-start gap-2 rounded-sm border border-(--color-border-subtle) bg-(--bg-input) py-1 pr-1 pl-1.5">
            <span className="mt-0.5 flex h-4 min-w-4 shrink-0 items-center justify-center rounded-full bg-(--color-accent) px-1 text-meta font-semibold text-(--color-text-on-accent)">
              {comment.n}
            </span>
            <div className="min-w-0 flex-1">
              {editing?.id === comment.id ? (
                <p className="truncate font-mono text-meta text-(--color-text-subtle)">{elementLabel(comment.element)} {comment.element.text}</p>
              ) : (
                // The whole comment is the way to its pin on the page.
                <button type="button" aria-label={`Show comment ${comment.n} on the page`} onClick={() => onShow(comment.n)} className="block w-full min-w-0 rounded-xs text-left">
                  <span className="block truncate font-mono text-meta text-(--color-text-subtle)">{elementLabel(comment.element)} {comment.element.text}</span>
                  <span className="mt-0.5 line-clamp-3 block text-xs leading-relaxed break-words whitespace-pre-wrap text-(--color-text)">{comment.text}</span>
                </button>
              )}
              {editing?.id === comment.id && (
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
                    <Button type="button" variant="ghost" size="xs" className="pointer-coarse:h-9" aria-label="Cancel edit" onClick={() => setEditing(null)}>
                      Cancel
                    </Button>
                    <Button type="button" variant="primary" size="xs" className="pointer-coarse:h-9" onClick={save} disabled={!editing.text.trim()}>
                      Save
                    </Button>
                  </div>
                </div>
              )}
            </div>
            {editing?.id !== comment.id && (
              <Button type="button" variant="ghost" size="icon-xs" className="pointer-coarse:size-9" aria-label={`Edit comment ${comment.n}`} onClick={() => setEditing({ id: comment.id, text: comment.text })}>
                <Pencil size={12} aria-hidden="true" />
              </Button>
            )}
            <CloseButton size="icon-xs" className="pointer-coarse:size-9" label={`Remove comment ${comment.n}`} tooltip="Remove comment" onClick={() => onRemove(comment.id)} />
          </li>
        ))}
      </ul>
      )}
    </section>
  )
}
