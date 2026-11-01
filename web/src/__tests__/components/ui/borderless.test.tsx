/**
 * Fewer borders (DESIGN.md → Components): controls carry no border of their
 * own. A chosen segment fills its track edge to edge with the theme accent,
 * buttons are fills, chips are soft, and menu rows highlight with a solid
 * accent fill like the OS menus. Borders stay on region separators, text
 * fields and the one hairline around a container.
 */
import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { render } from '@testing-library/react'

import { buttonVariants } from '@/components/ui/button'
import { chipClass } from '@/components/ui/chip'
import { MENU_ITEM_CLASS, MENU_PANEL_CLASS } from '@/components/ui/menu-styles'
import { segmentedItemClass, segmentedTrackClass } from '@/components/ui/segmented-control'
import { Switch } from '@/components/ui/switch'
import { tabsListVariants } from '@/components/ui/tabs'

const css = readFileSync(fileURLToPath(new URL('../../../index.css', import.meta.url)), 'utf8')

/** Classes that draw a border width (``border``, ``border-t``…), not colour-only tokens. */
function borderWidths(className: string): string[] {
  return className.split(/\s+/).filter((c) => /^(?:[\w-]+:)*border(?:-[trblxy])?(?:-\d)?$/.test(c))
}

describe('borderless controls', () => {
  it('draws no border on any button variant', () => {
    for (const variant of ['default', 'subtle', 'primary', 'ghost', 'danger', 'danger-subtle', 'link'] as const) {
      expect({ variant, borders: borderWidths(buttonVariants({ variant })) }).toEqual({ variant, borders: [] })
    }
  })

  it('fills the primary button with the theme accent', () => {
    const primary = buttonVariants({ variant: 'primary' })
    expect(primary).toContain('bg-(--color-accent)')
    expect(primary).toContain('text-(--color-text-on-accent)')
  })

  it('gives a segmented track no border and no padding ring', () => {
    const track = segmentedTrackClass()
    expect(borderWidths(track)).toEqual([])
    expect(track).not.toMatch(/(?:^|\s)p-0\.5(?:\s|$)/)
    expect(track).toContain('overflow-hidden')
  })

  it('fills the chosen segment edge to edge with the accent', () => {
    const active = segmentedItemClass({ active: true })
    expect(active).toContain('bg-(--color-accent)')
    expect(active).toContain('text-(--color-text-on-accent)')
    expect(borderWidths(active)).toEqual([])
    expect(active).not.toMatch(/(?:^|\s)rounded-xs(?:\s|$)/)
  })

  it('styles a tab list like a segmented track', () => {
    const list = tabsListVariants()
    expect(borderWidths(list)).toEqual([])
    expect(list).not.toMatch(/(?:^|\s)p-0\.5(?:\s|$)/)
  })

  it('has one chip style: soft', () => {
    expect(borderWidths(chipClass({ tone: 'neutral' }))).toEqual([])
    expect(borderWidths(chipClass({ tone: 'info' }))).toEqual([])
  })

  it('draws the switch track as a solid fill without a border', () => {
    const { getByRole, rerender } = render(<Switch checked={false} aria-label="Off switch" />)
    const off = getByRole('switch').className
    expect(borderWidths(off)).toEqual([])
    expect(off).toContain('bg-(--color-border-strong)')
    rerender(<Switch checked aria-label="On switch" />)
    expect(getByRole('switch').className).toContain('bg-(--accent-blue)')
  })

  it('frames a menu with one subtle hairline and highlights rows with a solid accent fill', () => {
    expect(MENU_PANEL_CLASS).toContain('border-(--color-border-subtle)')
    expect(MENU_ITEM_CLASS).toContain('oa-menu-item')
    expect(css).toMatch(/\.oa-menu-item:is\(\[data-highlighted\], :focus-visible, :active\):not\([^)]*\)\s*\{\s*background-color:\s*var\(--color-accent\);\s*color:\s*var\(--color-text-on-accent\);/)
    // A pointer hover lights a row only where hover exists (not after a tap).
    expect(css).toMatch(/@media \(hover: hover\)\s*\{\s*\.oa-menu-item:hover/)
  })
})
