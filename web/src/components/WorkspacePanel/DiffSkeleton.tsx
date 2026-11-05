import { DockLinesSkeleton } from './DockSkeleton'

/**
 * A diff on its way: a few code-line placeholders (Rulebook 10: loading is a
 * skeleton, not text), named for screen readers as the sidebar's are.
 */
export function DiffSkeleton() {
  return <DockLinesSkeleton label="Loading diff" />
}
