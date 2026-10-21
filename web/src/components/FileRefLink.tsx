/**
 * Clickable file references in the transcript: code spans, relative links,
 * and tool output that name a workspace file open it in the review dock, at
 * the line or range when one is given.
 *
 * The opener comes from context, so surfaces with no workspace to open into
 * (settings, memory, other panes) render the same text unlinked.
 */
import { createContext, useContext, useMemo, type AnchorHTMLAttributes, type HTMLAttributes, type ReactNode } from 'react'

import { findFileRefs, parseFileHref, parseFileRef, type FileRef } from '@/utils/file-refs'
import { openExternalUrl } from '@/lib/open-external'
import { copyText, useChatMenu } from './ChatContextMenu'
import type { ChangedFileStatus } from './WorkspacePanel/diff-helpers'

export interface FileRefOpener {
  /** The open workspace's root; rows use it to check a file is listed. */
  workspace?: string
  /** False for references outside the open workspace; those stay text. */
  canOpen: (ref: FileRef) => boolean
  open: (ref: FileRef) => void
  openDiff?: (ref: FileRef & { status?: ChangedFileStatus }) => void
}

export const FileRefContext = createContext<FileRefOpener | null>(null)

// Dotted and inheriting its colour: a reference reads as part of the text
// until hovered, since output can hold dozens of them.
const REF_CLASS = 'cursor-pointer rounded-xs underline decoration-dotted decoration-(--color-text-muted) underline-offset-2 hover:text-(--color-text) hover:decoration-solid focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-(--focus-ring)/40'

function refTitle(ref: FileRef): string {
  if (!ref.line) return `Open ${ref.path}`
  return ref.endLine ? `Open ${ref.path} at lines ${ref.line}-${ref.endLine}` : `Open ${ref.path} at line ${ref.line}`
}

/** A button that opens ``fileRef``; its text stays its accessible name. */
export function FileRefButton({ fileRef, opener, className, children }: {
  fileRef: FileRef
  opener: FileRefOpener
  className?: string
  children: ReactNode
}) {
  return (
    <button
      type="button"
      title={refTitle(fileRef)}
      onClick={() => opener.open(fileRef)}
      className={className ? `${REF_CLASS} ${className}` : REF_CLASS}
    >
      {children}
    </button>
  )
}

/** Markdown ``code``: a span that is only a file reference opens the file. */
export function FileRefCode({ children, ...props }: HTMLAttributes<HTMLElement> & { children: string }) {
  const opener = useContext(FileRefContext)
  const fileRef = opener ? parseFileRef(children) : null
  if (!opener || !fileRef || !opener.canOpen(fileRef)) return <code {...props}>{children}</code>
  return (
    <code {...props}>
      <FileRefButton fileRef={fileRef} opener={opener}>{children}</FileRefButton>
    </code>
  )
}

/** Markdown ``a``: a relative target opens the workspace file; the rest open a tab. */
export function MarkdownLink({ children, ...props }: AnchorHTMLAttributes<HTMLAnchorElement>) {
  const opener = useContext(FileRefContext)
  const fileRef = opener && typeof props.href === 'string' ? parseFileHref(props.href) : null
  const href = typeof props.href === 'string' ? props.href : ''
  const opensFile = Boolean(opener && fileRef && opener.canOpen(fileRef))
  const chatMenu = useChatMenu(`Actions for link ${href}`, () => href
    ? [
        { label: 'Open link', run: () => (opensFile && opener && fileRef ? opener.open(fileRef) : void openExternalUrl(href)) },
        { label: 'Copy link', run: () => copyText(href) },
      ]
    : [])
  // The link is the control; a file-named code span inside it stays text.
  const content = <FileRefContext.Provider value={null}>{children}</FileRefContext.Provider>
  if (!opensFile || !opener || !fileRef) {
    return (
      <a {...props} target="_blank" rel="noopener noreferrer" onContextMenu={chatMenu.onContextMenu} onKeyDown={chatMenu.onKeyDown}>
        {content}
        {chatMenu.menu}
      </a>
    )
  }
  return (
    <a
      {...props}
      title={props.title ?? refTitle(fileRef)}
      onClick={(event) => {
        event.preventDefault()
        opener.open(fileRef)
      }}
      onContextMenu={chatMenu.onContextMenu}
      onKeyDown={chatMenu.onKeyDown}
    >
      {content}
      {chatMenu.menu}
    </a>
  )
}

/** Text (tool output) with its file references linked. */
export function LinkifiedText({ text }: { text: string }) {
  const opener = useContext(FileRefContext)
  const parts = useMemo(() => {
    if (!opener) return null
    // A line that is wholly a file name (a glob entry) links whole.
    const whole = parseFileRef(text)
    if (whole) return opener.canOpen(whole) ? [{ text, ref: whole }] : null
    const out: Array<{ text: string; ref?: FileRef }> = []
    let cursor = 0
    for (const { start, end, ref } of findFileRefs(text)) {
      if (!opener.canOpen(ref)) continue
      if (start > cursor) out.push({ text: text.slice(cursor, start) })
      out.push({ text: text.slice(start, end), ref })
      cursor = end
    }
    if (out.length === 0) return null
    if (cursor < text.length) out.push({ text: text.slice(cursor) })
    return out
  }, [opener, text])

  if (!opener || !parts) return <>{text}</>
  return (
    <>
      {parts.map((part, index) => (part.ref
        ? <FileRefButton key={index} fileRef={part.ref} opener={opener}>{part.text}</FileRefButton>
        : part.text))}
    </>
  )
}
