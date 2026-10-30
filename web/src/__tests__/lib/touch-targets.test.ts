/**
 * DESIGN.md "Mobile Touch Parity Scaling": on coarse pointers, controls grow
 * toward a 44px target while desktop keeps its dense sizes. happy-dom does not
 * evaluate ``pointer: coarse``, so this guards the rules and class strings.
 */
import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { DOCK_ROW_ACTION_CLASS, dockTabCloseClass } from '@/components/WorkspacePanel/dock-tab-styles'

const css = readFileSync(fileURLToPath(new URL('../../index.css', import.meta.url)), 'utf8')

describe('coarse-pointer touch targets', () => {
  it('sets the shared list row and the dock tab strip to 44px on touch, and tightens line height', () => {
    expect(css).toMatch(/@media \(pointer: coarse\)\s*\{\s*:root\s*\{\s*--spacing-list-row:\s*2\.75rem;\s*--leading-relaxed:\s*1\.5;\s*--spacing-tab-bar:\s*2\.9375rem;/)
    expect(css).toMatch(/@media \(pointer: coarse\)\s*\{[^}]*\}\s*\.oa-prose\s*\{\s*line-height:\s*1\.6;/)
  })

  it('grows dock row actions and the tab close control on touch', () => {
    expect(DOCK_ROW_ACTION_CLASS).toContain('pointer-coarse:size-11')
    expect(dockTabCloseClass(false)).toContain('pointer-coarse:size-11')
    expect(dockTabCloseClass(true)).toContain('pointer-coarse:size-11')
  })

  it('sizes buttons 44px on touch, and 48dp in the Android app (Material)', () => {
    expect(css).toMatch(/@media \(pointer: coarse\)\s*\{\s*\[data-slot="button"\]\s*\{\s*min-height:\s*44px;\s*min-width:\s*44px;\s*\}/)
    expect(css).toMatch(/html\[data-mobile-shell="android"\] \[data-slot="button"\]\s*\{\s*min-height:\s*48px;\s*min-width:\s*48px;\s*\}/)
  })

  it('gives inline prose links and small strip icons a 44px hit area without reflowing them', () => {
    expect(css).toMatch(/\.oa-prose a::before,\s*\[data-file-ref\]::before\s*\{\s*content:\s*"";\s*position:\s*absolute;\s*inset:\s*calc\(\(100% - 44px\) \/ 2\) 0;/)
    expect(css).toMatch(/\.touch-hit::before\s*\{\s*content:\s*"";\s*position:\s*absolute;\s*inset:\s*min\(0px, calc\(\(100% - 44px\) \/ 2\)\);/)
  })

  it('makes every tab trigger 44px on touch', () => {
    const tabs = readFileSync(fileURLToPath(new URL('../../components/ui/tabs.tsx', import.meta.url)), 'utf8')
    expect(tabs.match(/pointer-coarse:data-\[orientation=horizontal\]:h-12\.5/g)?.length).toBe(2)
  })
})
