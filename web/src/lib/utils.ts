/**
 * cn — lightweight className utility.
 *
 * Accepts strings, arrays, objects (truthy-keyed), false/null/undefined.
 * Replaces the clsx + tailwind-merge combo. No class-conflict deduplication
 * is needed because our component variants produce non-conflicting class sets
 * and callers use props (variant/size) rather than className overrides for
 * structural properties.
 */
type ClassValue = string | number | boolean | null | undefined | ClassValue[]

export function cn(...inputs: ClassValue[]): string {
  const classes: string[] = []
  for (const input of inputs) {
    if (!input && input !== 0) continue
    if (typeof input === 'string') { classes.push(input); continue }
    if (typeof input === 'number') { classes.push(String(input)); continue }
    if (Array.isArray(input)) { const inner = cn(...input); if (inner) classes.push(inner); continue }
  }
  return classes.join(' ')
}
