import { Download } from 'lucide-react'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { CodingFilePreviewContent, CopyButton } from '../CodingFileViewerPanel'
import { FileTypeIcon } from '../FileTypeIcon'
import { downloadCodingWorkspaceFile } from '@/lib/coding-workspace-download'
import type { WorkspaceFileInfo } from '@/api/types'

interface FilePreviewSubPanelProps {
  workspace: string
  file: WorkspaceFileInfo
  onAddComment?: (path: string, startLine: number, endLine: number) => void
}

export function FilePreviewSubPanel({
  workspace,
  file,
  onAddComment,
}: FilePreviewSubPanelProps) {
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center justify-between gap-2 border-b border-(--color-border) bg-(--bg-key)/25 px-3 py-2">
        <div className="flex min-w-0 items-center gap-2">
          <FileTypeIcon name={file.name || file.path} size={16} />
          <Tooltip className="min-w-0">
            <TooltipTrigger
              className="min-w-0"
              render={<p className="truncate font-mono text-xs font-medium text-(--color-text)">{file.path}</p>}
            />
            <TooltipContent>{file.path}</TooltipContent>
          </Tooltip>
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          <Tooltip>
            <TooltipTrigger
              render={
                <button
                  type="button"
                  onClick={() => void downloadCodingWorkspaceFile(workspace, file)}
                  aria-label="Download file"
                  className="flex h-9 w-9 items-center justify-center rounded-md text-(--color-text-muted) transition-colors hover:bg-(--bg-key) hover:text-(--color-text) disabled:cursor-not-allowed disabled:opacity-40 md:h-auto md:w-auto md:p-1"
                >
                  <Download size={13} />
                </button>
              }
            />
            <TooltipContent>Download file</TooltipContent>
          </Tooltip>
          <CopyButton workspace={workspace} file={file} />
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-hidden">
        <CodingFilePreviewContent workspace={workspace} file={file} onAddComment={onAddComment} />
      </div>
    </div>
  )
}
