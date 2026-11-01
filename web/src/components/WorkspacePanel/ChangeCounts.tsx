import { cn } from '@/lib/utils'
import { type ChangedFileInfo, CHANGED_STATUS_LABELS } from './diff-helpers'

/**
 * ``+N -N M`` trailer shared by changed-file rows and diff toolbars. The
 * status letter is visual shorthand; screen readers get the word.
 */
export function ChangeCounts({ file, className }: { file: ChangedFileInfo; className?: string }) {
  return (
    <span className={cn('flex shrink-0 items-center gap-1.5 font-mono text-xs md:text-meta', className)}>
      {file.additions > 0 && <span className="text-(--color-diff-add-text)">+{file.additions}</span>}
      {file.deletions > 0 && <span className="text-(--color-diff-del-text)">-{file.deletions}</span>}
      <span className="w-2.5 text-center font-semibold text-(--accent-orange-text)">
        <span aria-hidden="true">{file.status}</span>
        <span className="sr-only">{CHANGED_STATUS_LABELS[file.status]}</span>
      </span>
    </span>
  )
}
