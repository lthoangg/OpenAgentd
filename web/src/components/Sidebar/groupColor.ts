import type { WorkspaceGroup } from '@/api/types'

/**
 * Accent tokens for groups that have not picked a colour, chosen by a stable
 * hash of the id so a group keeps its colour across renames, windows and
 * devices. Red is left out: unpicked, it would read as an error.
 */
const DERIVED_TOKENS = ['blue', 'green', 'orange', 'purple', 'pink'] as const

const HEX = /^#[0-9a-f]{6}$/i

function derivedToken(id: string): string {
  let hash = 0
  for (let i = 0; i < id.length; i++) hash = (hash * 31 + id.charCodeAt(i)) >>> 0
  return `--accent-${DERIVED_TOKENS[hash % DERIVED_TOKENS.length]}`
}

/** A group's colour as a CSS value: its picked colour, else a derived accent. */
export function groupColor(group: Pick<WorkspaceGroup, 'id' | 'color'>): string {
  return group.color && HEX.test(group.color) ? group.color : `var(${derivedToken(group.id)})`
}

/**
 * A group's colour as `#rrggbb`, for a colour input: the picked colour, else
 * the derived accent as the current theme renders it.
 */
export function groupColorHex(group: Pick<WorkspaceGroup, 'id' | 'color'>): string {
  if (group.color && HEX.test(group.color)) return group.color.toLowerCase()
  const value = typeof document === 'undefined' ? '' : getComputedStyle(document.documentElement).getPropertyValue(derivedToken(group.id)).trim()
  return HEX.test(value) ? value.toLowerCase() : '#808080'
}

/**
 * A typed or pasted hex colour as `#rrggbb`, or null when it is not one.
 * Takes `#rgb` / `#rrggbb` in any case, with or without the `#`, so a value
 * copied from a design tool works as is.
 */
export function parseHexColor(input: string): string | null {
  const raw = input.trim().replace(/^#/, '').toLowerCase()
  if (/^[0-9a-f]{6}$/.test(raw)) return `#${raw}`
  if (/^[0-9a-f]{3}$/.test(raw)) return `#${raw.replace(/./g, '$&$&')}`
  return null
}

/**
 * A starting colour for the `index`-th group: hues a golden angle apart, so
 * consecutive groups never land near each other.
 */
export function suggestedGroupColor(index: number): string {
  const hue = (index * 137.508) % 360
  const s = 0.65
  const l = 0.55
  const f = (n: number) => {
    const k = (n + hue / 30) % 12
    const c = l - s * Math.min(l, 1 - l) * Math.max(-1, Math.min(k - 3, 9 - k, 1))
    return Math.round(c * 255).toString(16).padStart(2, '0')
  }
  return `#${f(0)}${f(8)}${f(4)}`
}
