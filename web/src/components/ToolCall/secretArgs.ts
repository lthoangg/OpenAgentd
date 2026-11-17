/**
 * The row label of a `secret` call: `list`, the key names it asks for, or
 * `request`. Keys come as `{ name }` objects (or bare names from older calls).
 */
export function secretHeaderLabel(parsed: Record<string, unknown>): string {
  if (parsed.action === 'list') return 'list'
  const keys = Array.isArray(parsed.keys) ? parsed.keys : []
  const names = keys
    .map((k) => (typeof k === 'string' ? k : typeof (k as { name?: unknown })?.name === 'string' ? (k as { name: string }).name : ''))
    .filter(Boolean)
  return names.length ? names.join(', ') : 'request'
}
