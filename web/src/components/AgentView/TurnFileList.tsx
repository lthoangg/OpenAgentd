/**
 * The files a finished turn edited, opened from the "N files changed" action
 * on its footer. Each row opens its git diff in the review dock (or the file,
 * where the host has no diff view).
 */
import { useContext } from 'react'

import { cn } from '@/lib/utils'
import { FileRefContext } from '../FileRefLink'
import { FileTypeIcon } from '../FileTypeIcon'
import { ChangeCounts } from '../WorkspacePanel/ChangeCounts'
import type { ChangedFileInfo } from '../WorkspacePanel/diff-helpers'

const ROW = 'flex h-(--spacing-list-row) w-full min-w-0 items-center gap-2 px-3 text-left text-xs text-(--color-text-2)'
const ROW_HOVER = 'transition-colors duration-(--motion-instant) hover:bg-(--bg-key)/60 hover:text-(--color-text) focus-key:bg-(--bg-key)/60 focus-visible:outline-none'

export function TurnFileList({ id, files }: { id: string; files: readonly ChangedFileInfo[] }) {
  const opener = useContext(FileRefContext)
  return (
    // ``overflow-clip``, not ``hidden``: nothing here scrolls on its own.
    <ul
      id={id}
      aria-label="Files changed this turn"
      className="my-1 divide-y divide-(--color-border-subtle) overflow-clip rounded-sm border border-(--color-border-subtle) bg-(--bg-card)"
    >
      {files.map((file) => {
        const content = (
          <>
            <FileTypeIcon name={file.path} size={13} />
            <span className="min-w-0 flex-1 truncate font-mono">{file.path}</span>
            <ChangeCounts file={file} />
          </>
        )
        const ref = { path: file.path }
        const canOpen = Boolean(opener && opener.canOpen(ref) && (opener.openDiff ? true : file.status !== 'D'))
        return (
          <li key={file.path}>
            {canOpen ? (
              <button
                type="button"
                aria-label={opener?.openDiff ? `Open diff for ${file.path}` : `Open ${file.path}`}
                onClick={() => (opener?.openDiff ? opener.openDiff({ path: file.path, status: file.status }) : opener?.open(ref))}
                className={cn(ROW, ROW_HOVER, 'pointer-coarse:min-h-9')}
              >
                {content}
              </button>
            ) : (
              <div className={ROW}>{content}</div>
            )}
          </li>
        )
      })}
    </ul>
  )
}
