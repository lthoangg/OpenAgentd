import { useMemo, useState } from 'react'
import { Download, Globe } from 'lucide-react'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { SegmentedControl, type SegmentedOption } from '@/components/ui/segmented-control'
import { FilePreviewContent, CopyButton, canCopyFileContents, isMarkdownFile, type MarkdownView } from '../FileViewerPanel'
import { FileRefContext, type FileRefOpener } from '../FileRefLink'
import { FileTypeIcon } from '../FileTypeIcon'
import { downloadWorkspaceFile } from '@/lib/workspace-download'
import { useFileRevealStore } from '@/stores/useFileRevealStore'
import { useToastStore } from '@/stores/useToastStore'
import { documentRefCandidates, resolveDocumentRef } from '@/utils/file-refs'
import { formatBytes } from '@/utils/format'
import type { WorkspaceFileInfo } from '@/api/types'
import { DOCK_ACTION_BUTTON_CLASS } from './dock-tab-styles'

interface FilePreviewSubPanelProps {
  workspace: string
  file: WorkspaceFileInfo
  onAddComment?: (path: string, startLine: number, endLine: number) => void
  /** Shown for HTML files: open the file in a web preview tab. */
  onOpenPreview?: (path: string) => void
  /** Open a workspace-relative path as a file tab; enables file links in rendered markdown. */
  onOpenFile?: (path: string) => void
  /** Whether the workspace listing has ``path``; links to unlisted files report them missing. */
  isListed?: (path: string) => boolean
  /** The listing was cut short, so an unlisted file may still exist. */
  listingTruncated?: boolean
}

const HTML_FILE = /\.html?$/i

/** Last path segment (either separator). */
function fileBaseName(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).pop() ?? path
}

/** Everything before the last segment, without the trailing separator. */
function fileDirName(path: string): string {
  const base = fileBaseName(path)
  return path.slice(0, Math.max(0, path.length - base.length)).replace(/[\\/]+$/, '')
}

const MARKDOWN_VIEW_OPTIONS: readonly SegmentedOption<MarkdownView>[] = [
  { value: 'rendered', label: 'Rendered' },
  { value: 'source', label: 'Source' },
]

/**
 * How links in a rendered markdown file open workspace files: read from the
 * file's folder, then the root; HTML in Preview, the rest as file tabs.
 */
function documentFileOpener(
  workspace: string,
  fromFile: string,
  onOpenFile: (path: string) => void,
  onOpenPreview: ((path: string) => void) | undefined,
  isListed: (path: string) => boolean,
  truncated: boolean,
): FileRefOpener {
  return {
    workspace,
    canOpen: (ref) => documentRefCandidates(fromFile, ref.path, workspace).length > 0,
    open: (ref) => {
      const match = resolveDocumentRef(fromFile, ref.path, workspace, isListed, truncated)
      if (!match) return
      if (match.kind === 'missing') {
        useToastStore.getState().push({ tone: 'info', title: 'File not found', description: `No file in this workspace matches ${ref.path}.` })
        return
      }
      if (HTML_FILE.test(match.path) && onOpenPreview) {
        onOpenPreview(match.path)
        return
      }
      onOpenFile(match.path)
      if (ref.line) useFileRevealStore.getState().reveal(match.path, ref.line, ref.endLine)
    },
  }
}

const ALWAYS_LISTED = () => true

/** A file tab: one 32px toolbar (path, size, actions) over the preview. */
export function FilePreviewSubPanel({
  workspace,
  file,
  onAddComment,
  onOpenPreview,
  onOpenFile,
  isListed = ALWAYS_LISTED,
  listingTruncated = false,
}: FilePreviewSubPanelProps) {
  const deleted = file.deleted === true
  const downloadLabel = deleted ? 'File deleted from workspace' : 'Download file'
  const markdown = isMarkdownFile(file)
  // Markdown opens rendered; each file starts over when the tab shows another.
  const [view, setView] = useState<{ path: string; value: MarkdownView }>({ path: file.path, value: 'rendered' })
  let markdownView: MarkdownView = view.path === file.path ? view.value : 'rendered'
  // A ``path:line`` reference needs line numbers: show the source.
  const revealing = useFileRevealStore((s) => s.request?.path === file.path)
  if (markdown && revealing && markdownView !== 'source') {
    markdownView = 'source'
    setView({ path: file.path, value: 'source' })
  }
  const fileOpener = useMemo(
    () => (onOpenFile ? documentFileOpener(workspace, file.path, onOpenFile, onOpenPreview, isListed, listingTruncated) : null),
    [workspace, file.path, onOpenFile, onOpenPreview, isListed, listingTruncated],
  )

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-(--spacing-toolbar) shrink-0 items-center gap-2 border-b border-(--color-border-subtle) bg-(--bg-page) pr-1 pl-3">
        <FileTypeIcon name={file.name || file.path} size={13} />
        <Tooltip className="min-w-0 flex-1">
          <TooltipTrigger
            className="min-w-0 flex-1"
            // The file name leads and the folder (muted) gives way first, so a
            // narrow dock shows "Foo.tsx src/comp…" rather than "src/comp…".
            render={
              <p data-file-preview-path="" className="flex min-w-0 items-baseline gap-1.5 font-mono text-xs" aria-label={file.path}>
                <span className="min-w-0 truncate text-(--color-text)">{fileBaseName(file.path)}</span>
                {fileDirName(file.path) && (
                  <span className="min-w-0 shrink-[4] truncate text-[11px] text-(--color-text-muted)">{fileDirName(file.path)}</span>
                )}
              </p>
            }
          />
          <TooltipContent side="bottom">{file.path}</TooltipContent>
        </Tooltip>
        {file.size > 0 && (
          <span className="hidden shrink-0 font-mono text-[11px] text-(--color-text-subtle) md:inline">{formatBytes(file.size)}</span>
        )}
        <div className="flex shrink-0 items-center gap-0.5">
          {markdown && (
            <SegmentedControl
              label="Markdown view"
              size="sm"
              value={markdownView}
              onChange={(value) => setView({ path: file.path, value })}
              options={MARKDOWN_VIEW_OPTIONS}
              className="mr-1"
            />
          )}
          {onOpenPreview && !deleted && HTML_FILE.test(file.path) && (
            <Tooltip>
              <TooltipTrigger
                render={
                  <button
                    type="button"
                    onClick={() => onOpenPreview(file.path)}
                    aria-label="Open in preview"
                    className={DOCK_ACTION_BUTTON_CLASS}
                  >
                    <Globe size={13} aria-hidden="true" />
                  </button>
                }
              />
              <TooltipContent side="bottom">Open in preview</TooltipContent>
            </Tooltip>
          )}
          <Tooltip>
            <TooltipTrigger
              render={
                <button
                  type="button"
                  onClick={() => void downloadWorkspaceFile(workspace, file)}
                  disabled={deleted}
                  aria-label={downloadLabel}
                  className={DOCK_ACTION_BUTTON_CLASS}
                >
                  <Download size={13} aria-hidden="true" />
                </button>
              }
            />
            <TooltipContent side="bottom">{downloadLabel}</TooltipContent>
          </Tooltip>
          {canCopyFileContents(file) && <CopyButton workspace={workspace} file={file} />}
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-hidden">
        <FileRefContext.Provider value={fileOpener}>
          <FilePreviewContent workspace={workspace} file={file} onAddComment={onAddComment} markdownView={markdownView} />
        </FileRefContext.Provider>
      </div>
    </div>
  )
}
