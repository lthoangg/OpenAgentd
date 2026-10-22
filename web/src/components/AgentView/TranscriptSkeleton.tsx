import { Skeleton } from '@/components/ui/skeleton'

const ANSWER_LINE_WIDTHS = [['w-full', 'w-11/12', 'w-3/5'], ['w-full', 'w-4/5']]

/**
 * Stand-in for a saved session's transcript while its history loads: a
 * prompt bubble and answer lines per turn, so the real turns land where the
 * placeholder was. It fades in only after a beat (`oa-fade-in-late`), so a
 * fast load goes straight from blank to the transcript without a flash.
 */
export function TranscriptSkeleton() {
  return (
    <div role="status" aria-label="Loading conversation" aria-busy="true" className="oa-fade-in-late space-y-6">
      {ANSWER_LINE_WIDTHS.map((lines, turn) => (
        <div key={turn} aria-hidden="true" className="space-y-3">
          <div className="flex justify-end">
            <Skeleton className={turn === 0 ? 'h-10 w-2/5' : 'h-10 w-1/3'} />
          </div>
          <div className="space-y-2">
            {lines.map((width) => <Skeleton key={width} className={`h-3 ${width}`} />)}
          </div>
        </div>
      ))}
    </div>
  )
}
