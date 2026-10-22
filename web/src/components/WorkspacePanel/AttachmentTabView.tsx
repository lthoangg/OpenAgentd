/**
 * An attachment tab: a file sent with a message, shown from its upload URL.
 * Uploads live in the session folder, not the workspace, so this reads the
 * file by URL instead of going through the workspace file preview.
 */
import { useEffect, useState } from 'react'
import { Download, ExternalLink } from 'lucide-react'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { FileLightboxGeneric, triggerDownload, type FileLightboxItem } from '../FileLightbox'
import { FileTypeIcon } from '../FileTypeIcon'
import { PdfDocumentViewer } from '../PdfDocumentViewer'
import { DOCK_ACTION_BUTTON_CLASS } from './dock-tab-styles'

const FAILED = 'flex h-full items-center justify-center text-sm text-(--color-text-muted)'

function ImageView({ item }: { item: FileLightboxItem }) {
  const [error, setError] = useState(false)
  if (error) return <div className={FAILED}>Failed to load image</div>
  return (
    <div className="flex h-full items-center justify-center overflow-auto p-4">
      <img src={item.src} alt={item.name} onError={() => setError(true)} className="max-h-full max-w-full rounded-sm object-contain" />
    </div>
  )
}

function TextView({ item }: { item: FileLightboxItem }) {
  const [content, setContent] = useState<string | null>(item.textContent ?? null)
  useEffect(() => {
    if (item.textContent !== undefined || !item.src) return
    let cancelled = false
    fetch(item.src)
      .then((r) => (r.ok ? r.text() : Promise.reject(new Error(String(r.status)))))
      .then((t) => { if (!cancelled) setContent(t) })
      .catch(() => { if (!cancelled) setContent('(failed to load)') })
    return () => { cancelled = true }
  }, [item.src, item.textContent])
  return (
    <pre className="selectable-text h-full overflow-auto whitespace-pre-wrap break-words p-4 font-mono text-xs leading-relaxed text-(--color-text)">
      {content ?? 'Loading…'}
    </pre>
  )
}

function AttachmentBody({ item }: { item: FileLightboxItem }) {
  switch (item.type) {
    case 'image':
      return <ImageView item={item} />
    case 'video':
      return (
        <div className="flex h-full items-center justify-center p-4">
          <video src={item.src} controls playsInline className="max-h-full max-w-full rounded-sm" />
        </div>
      )
    case 'audio':
      return (
        <div className="flex h-full items-center justify-center p-4">
          <audio src={item.src} controls className="w-full max-w-sm" />
        </div>
      )
    case 'pdf':
      return <PdfDocumentViewer src={item.src} className="h-full w-full" />
    case 'text':
      return <TextView item={item} />
    default:
      return (
        <div className="flex h-full items-center justify-center p-4">
          <FileLightboxGeneric item={item} />
        </div>
      )
  }
}

function ToolbarButton({ label, onClick, children }: { label: string; onClick: () => void; children: React.ReactNode }) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button type="button" onClick={onClick} aria-label={label} className={DOCK_ACTION_BUTTON_CLASS}>
            {children}
          </button>
        }
      />
      <TooltipContent side="bottom">{label}</TooltipContent>
    </Tooltip>
  )
}

/** One 32px toolbar (name, actions) over the attachment, like a file tab. */
export function AttachmentTabView({ item }: { item: FileLightboxItem }) {
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-(--spacing-toolbar) shrink-0 items-center gap-2 border-b border-(--color-border-subtle) bg-(--bg-page) pr-1 pl-3">
        <FileTypeIcon name={item.name} size={13} />
        <p className="min-w-0 flex-1 truncate font-mono text-xs text-(--color-text)" title={item.name}>{item.name}</p>
        <div className="flex shrink-0 items-center gap-0.5">
          {/* A link, as in the lightbox, so the shell's link handling applies. */}
          <Tooltip>
            <TooltipTrigger
              render={
                <a href={item.src} target="_blank" rel="noopener noreferrer" aria-label="Open in new tab" className={DOCK_ACTION_BUTTON_CLASS}>
                  <ExternalLink size={13} aria-hidden="true" />
                </a>
              }
            />
            <TooltipContent side="bottom">Open in new tab</TooltipContent>
          </Tooltip>
          <ToolbarButton label="Download file" onClick={() => void triggerDownload(item)}>
            <Download size={13} aria-hidden="true" />
          </ToolbarButton>
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-hidden">
        <AttachmentBody key={item.src} item={item} />
      </div>
    </div>
  )
}
