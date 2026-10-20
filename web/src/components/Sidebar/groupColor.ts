/**
 * A workspace group's colour: picked from the accent palette by a stable
 * hash of its id, so a group keeps its colour across renames, windows and
 * devices without storing one.
 */
const GROUP_COLORS = [
  'var(--accent-blue)',
  'var(--accent-green)',
  'var(--accent-orange)',
  'var(--accent-purple)',
  'var(--accent-pink)',
] as const

export function groupColor(id: string): string {
  let hash = 0
  for (let i = 0; i < id.length; i++) hash = (hash * 31 + id.charCodeAt(i)) >>> 0
  return GROUP_COLORS[hash % GROUP_COLORS.length]
}
