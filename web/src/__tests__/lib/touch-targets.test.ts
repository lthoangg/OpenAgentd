/**
 * DESIGN.md "Mobile Touch Parity Scaling": on coarse pointers, controls grow
 * toward one compact 36px target (40px in the Android app) while desktop
 * keeps its dense sizes. happy-dom does not
 * evaluate ``pointer: coarse``, so this guards the rules and class strings.
 */
import { describe, expect, it } from 'bun:test'
import { readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { DOCK_ACTION_BUTTON_CLASS, DOCK_ROW_ACTION_CLASS, dockTabCloseClass } from '@/components/WorkspacePanel/dock-tab-styles'
import { segmentedItemClass, segmentedTrackClass } from '@/components/ui/segmented-control'

const css = readFileSync(fileURLToPath(new URL('../../index.css', import.meta.url)), 'utf8')

describe('coarse-pointer touch targets', () => {
  it('sets the shared list row and the dock tab strip to 36px on touch, and tightens line height', () => {
    expect(css).toMatch(/@media \(pointer: coarse\)\s*\{\s*:root\s*\{\s*--spacing-list-row:\s*2\.25rem;\s*--leading-relaxed:\s*1\.5;\s*--spacing-tab-bar:\s*2\.4375rem;/)
    expect(css).toMatch(/@media \(pointer: coarse\)\s*\{[^}]*\}\s*\.oa-prose\s*\{\s*line-height:\s*1\.6;/)
  })

  it('grows dock row actions and the tab close control on touch', () => {
    expect(DOCK_ROW_ACTION_CLASS).toContain('pointer-coarse:size-9')
    expect(dockTabCloseClass(false)).toContain('pointer-coarse:size-9')
    expect(dockTabCloseClass(true)).toContain('pointer-coarse:size-9')
  })

  it('sizes buttons 36px on touch, and 40px in the Android app', () => {
    expect(css).toMatch(/@media \(pointer: coarse\)\s*\{\s*\[data-slot="button"\]\s*\{\s*min-height:\s*36px;\s*min-width:\s*36px;\s*\}/)
    expect(css).toMatch(/html\[data-mobile-shell="android"\] \[data-slot="button"\]\s*\{\s*min-height:\s*40px;\s*min-width:\s*40px;\s*\}/)
  })

  it('gives inline prose links and small strip icons a 36px hit area without reflowing them', () => {
    expect(css).toMatch(/\.oa-prose a::before,\s*\[data-file-ref\]::before\s*\{\s*content:\s*"";\s*position:\s*absolute;\s*inset:\s*calc\(\(100% - 36px\) \/ 2\) 0;/)
    expect(css).toMatch(/\.touch-hit::before\s*\{\s*content:\s*"";\s*position:\s*absolute;\s*inset:\s*min\(0px, calc\(\(100% - 36px\) \/ 2\)\);/)
  })

  it('makes default tab triggers 36px on touch and keeps sm tabs inside the 32px toolbar', () => {
    const tabs = readFileSync(fileURLToPath(new URL('../../components/ui/tabs.tsx', import.meta.url)), 'utf8')
    expect(tabs).toMatch(/default: '[^']*pointer-coarse:data-\[orientation=horizontal\]:h-10\.5/)
    expect(tabs).toMatch(/sm: '[^']*pointer-coarse:data-\[orientation=horizontal\]:h-7'/)
  })

  it('keeps sm segmented controls and toolbar icon actions inside the 32px toolbar on touch', () => {
    // 28px, like sm tabs. Icon actions keep a 36px hit area via ``touch-hit``.
    const track = segmentedTrackClass({ size: 'sm' })
    expect(track).toContain('pointer-coarse:h-7')
    expect(track).not.toContain('pointer-coarse:h-auto')
    const item = segmentedItemClass({ active: false, size: 'sm' })
    expect(item).not.toContain('pointer-coarse:min-h-9')
    expect(DOCK_ACTION_BUTTON_CLASS).toContain('pointer-coarse:size-7')
    expect(DOCK_ACTION_BUTTON_CLASS).not.toContain('pointer-coarse:size-9')
    expect(DOCK_ACTION_BUTTON_CLASS).toContain('touch-hit')
  })

  it('grows the small controls found in the phone audit to 36px on touch', () => {
    const src = (rel: string) => readFileSync(fileURLToPath(new URL(`../../components/${rel}`, import.meta.url)), 'utf8')
    const cases: Array<[string, RegExp]> = [
      ['ToastStack.tsx', /aria-label="Dismiss"[\s\S]{0,40}className="[^"]*pointer-coarse:size-9/],
      ['Telemetry/SessionHeader.tsx', /pointer-coarse:h-9"[\s\S]{0,80}Open session/],
      ['PendingMessageQueue.tsx', /aria-label=\{expanded \? 'Collapse' : 'Expand'\}\s*className="[^"]*pointer-coarse:size-9/],
      ['PendingMessageQueue.tsx', /aria-label="Edit queued message"\s*className="[^"]*pointer-coarse:size-9/],
      ['settings/WorkspaceGroupsSettings.tsx', /aria-label=\{`Remove \$\{repo\.name\} from[\s\S]{0,300}className="[^"]*pointer-coarse:size-9/],
      ['settings/pages/settings.providers/CredentialList.tsx', /aria-label=\{`New name for[\s\S]{0,300}className="[^"]*pointer-coarse:h-9/],
    ]
    for (const [file, pattern] of cases) expect([file, pattern.test(src(file))]).toEqual([file, true])
  })

  it('keeps phone toasts below the app header', () => {
    expect(css).toMatch(/\.mobile-safe-toast\s*\{\s*top:\s*calc\(env\(safe-area-inset-top, 0px\) \+ var\(--spacing-app-header\) \+ 0\.5rem\);/)
  })

  it('uses no 44px touch sizes: phones stay compact enough for a mini screen', () => {
    const root = fileURLToPath(new URL('../../components', import.meta.url))
    const offenders: string[] = []
    const files = readdirSync(root, { recursive: true, encoding: 'utf8' }).filter((f) => /\.tsx?$/.test(f))
    for (const file of files) {
      const text = readFileSync(`${root}/${file}`, 'utf8')
      if (/pointer-coarse:[\w:\-[\]=]*(?:min-h|min-w|size|h|w)-11\b/.test(text)) offenders.push(file)
    }
    expect(offenders).toEqual([])
  })
})
