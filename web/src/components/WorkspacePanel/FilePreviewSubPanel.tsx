import { useState } from 'react'
import { Download, Globe } from 'lucide-react'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { SegmentedControl, type SegmentedOption } from '@/components/ui/segmented-control'
import { FilePreviewContent, CopyButton, canCopyFileContents, isMarkdownFile, type MarkdownView } from '../FileViewerPanel'
import { FileTypeIcon } from '../FileTypeIcon'
import { downloadWorkspaceFile } from '@/lib/workspace-download'
import { useFileRevealStore } from '@/stores/useFileRevealStore'
import { formatBytes } from '@/utils/format'
import type { WorkspaceFileInfo } from '@/api/types'
import { DOCK_ACTION_BUTTON_CLASS } from './dock-tab-styles'

interface FilePreviewSubPanelProps {
  workspace: string
  file: WorkspaceFileInfo
  onAddComment?: (path: string, startLine: number, endLine: number) => void
  /** Shown for HTML files: open the file in a web preview tab. */
  onOpenPreview?: (path: string) => void
}

const HTML_FILE = /\.html?$/i

const MARKDOWN_VIEW_OPTIONS: readonly SegmentedOption<MarkdownView>[] = [
  { value: 'rendered', label: 'Rendered' },
  { value: 'source', label: 'Source' },
]

/** A file tab: one 32px toolbar (path, size, actions) over the preview. */
export function FilePreviewSubPanel({
  workspace,
  file,
  onAddComment,
  onOpenPreview,
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

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-(--spacing-toolbar) shrink-0 items-center gap-2 border-b border-(--color-border-subtle) bg-(--bg-page) pr-1 pl-3">
        <FileTypeIcon name={file.name || file.path} size={13} />
        <Tooltip className="min-w-0 flex-1">
          <TooltipTrigger
            className="min-w-0 flex-1"
            render={<p className="truncate font-mono text-xs text-(--color-text)">{file.path}</p>}
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
                    aria-label="Open in Preview"
                    className={DOCK_ACTION_BUTTON_CLASS}
                  >
                    <Globe size={13} aria-hidden="true" />
                  </button>
                }
              />
              <TooltipContent side="bottom">Open in Preview</TooltipContent>
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
        <FilePreviewContent workspace={workspace} file={file} onAddComment={onAddComment} markdownView={markdownView} />
      </div>
    </div>
  )
}
