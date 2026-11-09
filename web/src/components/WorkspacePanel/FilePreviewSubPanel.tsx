import { useMemo, useState } from 'react'
import { Copy, Download, Globe } from 'lucide-react'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { SegmentedControl, type SegmentedOption } from '@/components/ui/segmented-control'
import { ActionSheet, type ActionSheetItem } from '@/components/ui/action-sheet'
import { CONTEXT_MENU_ITEM_CLASS, ContextMenu } from '@/components/ui/context-menu'
import { LongPressButton } from '@/components/ui/long-press-button'
import { FilePreviewContent, CopyFileButton, canCopyFileContents, isMarkdownFile, type MarkdownView } from '../FileViewerPanel'
import { FileRefContext, type FileRefOpener } from '../FileRefLink'
import { FileTypeIcon } from '../FileTypeIcon'
import { copyText } from '../ChatContextMenu'
import { downloadWorkspaceFile } from '@/lib/workspace-download'
import { isMenuKey, menuPointFor } from '@/lib/focus/item-keys'
import { useFileRevealStore } from '@/stores/useFileRevealStore'
import { useToastStore } from '@/stores/useToastStore'
import { documentRefCandidates, resolveDocumentRef } from '@/utils/file-refs'
import { formatBytes } from '@/utils/format'
import { absoluteWorkspacePath } from '@/utils/workspace'
import type { WorkspaceFileInfo } from '@/api/types'
import { DOCK_ACTION_BUTTON_CLASS } from './dock-tab-styles'
import { DockRefreshButton } from './DockRefreshButton'

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
  /** Reloads the workspace's files (the file's size and contents follow); omitted, no button. */
  onRefresh?: () => void
  /** Phone layout: a long-press on the path opens a sheet instead of the right-click menu. */
  mobile?: boolean
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

/**
 * The file's path in the toolbar. Right-click (Shift+F10 or the Menu key from
 * the keyboard) opens a menu to copy it, absolute or relative; on a phone a
 * long-press opens the same choices as a sheet.
 */
function FilePathLabel({ workspace, path, mobile }: { workspace: string; path: string; mobile: boolean }) {
  const [menuAt, setMenuAt] = useState<{ x: number; y: number } | null>(null)
  const [sheetOpen, setSheetOpen] = useState(false)
  const copyAbsolute = () => copyText(absoluteWorkspacePath(workspace, path))
  const copyRelative = () => copyText(path)
  const sheetItems: ActionSheetItem[] = [
    { id: 'copy-path', label: 'Copy path', icon: Copy, run: copyAbsolute },
    { id: 'copy-relative-path', label: 'Copy relative path', icon: Copy, run: copyRelative },
  ]
  const dir = fileDirName(path)
  return (
    <>
      <Tooltip className="min-w-0 flex-1">
        <TooltipTrigger
          className="min-w-0 flex-1"
          // The file name leads and the folder (muted) gives way first, so a
          // narrow dock shows "Foo.tsx src/comp…" rather than "src/comp…".
          render={
            <LongPressButton
              type="button"
              data-file-preview-path=""
              enabled={mobile}
              onLongPress={() => setSheetOpen(true)}
              onContextMenu={(e) => {
                if (mobile) return
                e.preventDefault()
                setMenuAt({ x: e.clientX, y: e.clientY })
              }}
              onKeyDown={(e) => {
                if (mobile || !isMenuKey(e)) return
                e.preventDefault()
                const at = menuPointFor(e.currentTarget)
                setMenuAt({ x: at.clientX, y: at.clientY })
              }}
              aria-keyshortcuts={mobile ? undefined : 'Shift+F10'}
              className="flex min-w-0 cursor-default items-baseline gap-1.5 rounded-sm text-left font-mono text-xs outline-none focus-key:bg-(--bg-key)/60"
              aria-label={`File path ${path}`}
            >
              <span className="min-w-0 truncate text-(--color-text)">{fileBaseName(path)}</span>
              {dir && <span className="min-w-0 shrink-[4] truncate text-meta text-(--color-text-muted)">{dir}</span>}
            </LongPressButton>
          }
        />
        <TooltipContent side="bottom">{path}</TooltipContent>
      </Tooltip>
      {menuAt && (
        <ContextMenu at={menuAt} label={`Actions for ${path}`} onDismiss={() => setMenuAt(null)}>
          <button type="button" role="menuitem" className={CONTEXT_MENU_ITEM_CLASS} onClick={() => { setMenuAt(null); copyAbsolute() }}>
            <Copy size={12} aria-hidden="true" />
            Copy path
          </button>
          <button type="button" role="menuitem" className={CONTEXT_MENU_ITEM_CLASS} onClick={() => { setMenuAt(null); copyRelative() }}>
            <Copy size={12} aria-hidden="true" />
            Copy relative path
          </button>
        </ContextMenu>
      )}
      {mobile && <ActionSheet open={sheetOpen} onClose={() => setSheetOpen(false)} title={path} items={sheetItems} />}
    </>
  )
}

/** A file tab: one 32px toolbar (path, size, actions, Refresh last) over the preview. */
export function FilePreviewSubPanel({
  workspace,
  file,
  onAddComment,
  onOpenPreview,
  onOpenFile,
  isListed = ALWAYS_LISTED,
  listingTruncated = false,
  onRefresh,
  mobile = false,
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
        <FilePathLabel workspace={workspace} path={file.path} mobile={mobile} />
        {file.size > 0 && (
          <span className="hidden shrink-0 font-mono text-meta text-(--color-text-subtle) md:inline">{formatBytes(file.size)}</span>
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
                    <Globe size={14} aria-hidden="true" />
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
                  <Download size={14} aria-hidden="true" />
                </button>
              }
            />
            <TooltipContent side="bottom">{downloadLabel}</TooltipContent>
          </Tooltip>
          {canCopyFileContents(file) && <CopyFileButton workspace={workspace} file={file} />}
          {onRefresh && <DockRefreshButton label="Refresh file" onClick={onRefresh} />}
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
