/**
 * DESIGN.md "Mobile Touch Parity Scaling": on coarse pointers, controls grow
 * toward one compact 36px target (40px in the Android app) while desktop
 * keeps its dense sizes. happy-dom does not
 * evaluate ``pointer: coarse``, so this guards the rules and class strings.
 */
import { describe, expect, it } from 'bun:test'
import { readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { DOCK_ACTION_BUTTON_CLASS, DOCK_ROW_ACTION_CLASS, DOCK_TAB_CLOSE_CLASS } from '@/components/WorkspacePanel/dock-tab-styles'
import { rowChipClass } from '@/components/ui/list-row'
import { MENU_ITEM_CLASS } from '@/components/ui/menu-styles'
import { segmentedItemClass, segmentedTrackClass } from '@/components/ui/segmented-control'

const css = readFileSync(fileURLToPath(new URL('../../index.css', import.meta.url)), 'utf8')

describe('coarse-pointer touch targets', () => {
  it('sets the shared list row and the dock tab strip to 36px on touch, and tightens line height', () => {
    expect(css).toMatch(/@media \(pointer: coarse\)\s*\{\s*:root\s*\{\s*--spacing-list-row:\s*2\.25rem;\s*--leading-relaxed:\s*1\.5;\s*--spacing-tab-bar:\s*2\.8125rem;/)
    expect(css).toMatch(/@media \(pointer: coarse\)\s*\{[^}]*\}\s*\.oa-prose\s*\{\s*line-height:\s*1\.6;/)
  })

  it('grows dock row actions and the tab close control on touch', () => {
    expect(DOCK_ROW_ACTION_CLASS).toContain('pointer-coarse:size-9')
    expect(DOCK_TAB_CLOSE_CLASS).toContain('pointer-coarse:size-9')
  })

  it('shows every tab close at rest, 24px (the CloseButton primitive at icon-xs), never hidden or faded', () => {
    expect(DOCK_TAB_CLOSE_CLASS).not.toMatch(/(^|\s)(hidden|opacity-\d+|size-5)(\s|$)/)
    const button = readFileSync(fileURLToPath(new URL('../../components/ui/button.tsx', import.meta.url)), 'utf8')
    expect(button).toMatch(/'icon-xs':\s*'size-6 /)
    const tab = readFileSync(fileURLToPath(new URL('../../components/WorkspacePanel/DockTabCloseButton.tsx', import.meta.url)), 'utf8')
    expect(tab).toContain('size="icon-xs"')
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
    // No padding ring or border around the triggers, so the list is one trigger tall.
    expect(tabs).toMatch(/default: '[^']*pointer-coarse:data-\[orientation=horizontal\]:h-9'/)
    expect(tabs).toMatch(/sm: '[^']*pointer-coarse:data-\[orientation=horizontal\]:h-7[ ']/)
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
      ['Telemetry/SessionHeader.tsx', /pointer-coarse:h-9"[\s\S]{0,80}Open session/],
      ['settings/WorkspaceGroupsSettings.tsx', /aria-label=\{`Remove \$\{repo\.name\} from[\s\S]{0,300}className="[^"]*pointer-coarse:size-9/],
      ['settings/pages/settings.providers/CredentialList.tsx', /aria-label=\{`New name for[\s\S]{0,300}className="[^"]*pointer-coarse:h-9/],
      // Review panel views (audit R10-R12): scheduler ⋯, preview address, model list controls.
      // ROW_ACTION is 24px and pointer-coarse:size-9 (see list-row.ts).
      ['SchedulerPanel/TaskListItem.tsx', /className=\{ROW_ACTION\}\s*aria-haspopup="menu"\s*aria-label=\{`More actions for/],
      ['Preview/PreviewTabView.tsx', /aria-label="Preview address"[\s\S]{0,1400}pointer-coarse:h-9/],
      ['settings/pages/settings.providers/ModelsPanel.tsx', /aria-pressed=\{selected\}[\s\S]{0,500}pointer-coarse:h-9/],
      ['settings/pages/settings.providers/ModelsPanel.tsx', /aria-label=\{`Copy \$\{qualifiedId\}`\}\s*className="[^"]*pointer-coarse:size-9/],
    ]
    for (const [file, pattern] of cases) expect([file, pattern.test(src(file))]).toEqual([file, true])
  })

  it('hangs the notice column from the top right, under the app header', () => {
    expect(css).toMatch(/\.mobile-safe-floating\s*\{\s*top:\s*calc\(env\(safe-area-inset-top, 0px\) \+ var\(--spacing-app-header\) \+ 0\.5rem\);/)
    // The composer and its run deck own the bottom: no rule anchors a notice there any more.
    const rule = /\.mobile-safe-floating\s*\{[^}]*\}/.exec(css)?.[0] ?? ''
    expect(rule).not.toMatch(/bottom\s*:/)
  })

  it('keeps every touch control at 36px, Send included, for a mini screen', () => {
    const root = fileURLToPath(new URL('../../components', import.meta.url))
    // 36px for every control on touch. Send was 44px on phones, which stood
    // taller than the Steer / Queue halves it splits into and the mode toggle.
    const offenders: string[] = []
    const files = readdirSync(root, { recursive: true, encoding: 'utf8' }).filter((f) => /\.tsx?$/.test(f))
    for (const file of files) {
      const text = readFileSync(`${root}/${file}`, 'utf8')
      if (/pointer-coarse:[\w:\-[\]=]*(?:min-h|min-w|size|h|w)-11\b/.test(text)) offenders.push(file)
    }
    expect(offenders).toEqual([])
  })

  it('sizes Send to 36px on touch, a phone included, as the split Steer half beside its chevron', () => {
    const composer = readFileSync(fileURLToPath(new URL('../../components/InputComposer.tsx', import.meta.url)), 'utf8')
    expect(composer).toMatch(/sendSlotClass =\s*'[^']*pointer-coarse:size-9'/)
    expect(composer).toMatch(/DELIVERY_TRIGGER_CLASS =[\s\S]*?pointer-coarse:h-9 \[/)
    expect(composer).not.toMatch(/phone:(size|h)-11/)
  })
})

/**
 * The app's own size rule (DESIGN.md → Phone scale): a phone's rows and
 * controls read ``--phone-control`` (40px, 44px in the Android app), a
 * tablet's are 36px, and a mouse's row actions 24px. These controls measured
 * under it; each now takes its height from the token, not a fixed number.
 */
describe('controls that measured under the size rule', () => {
  const src = (rel: string) => readFileSync(fileURLToPath(new URL(`../../components/${rel}`, import.meta.url)), 'utf8')

  it('sizes a menu row from the phone step on a phone, so a sheet row is never the tablet 36px', () => {
    // ``cn`` does not merge: the phone height must sit in the shared class,
    // after the coarse one, or the + menu, model and folder rows stay 36px.
    expect(MENU_ITEM_CLASS).toMatch(/pointer-coarse:min-h-9 phone:min-h-\(--phone-control\)/)
  })

  it('sizes default segments and the row chip from the phone step on a phone', () => {
    expect(segmentedItemClass({ active: false })).toContain('phone:min-h-(--phone-control)')
    expect(rowChipClass()).toMatch(/phone:h-\(--phone-control\) phone:min-w-\(--phone-control\)/)
  })

  it('gives the row chip a 24px target with a mouse without changing the 20px pill', () => {
    expect(rowChipClass()).toMatch(/(^|\s)h-5(\s|$)/)
    expect(rowChipClass()).toContain('pointer-fine:before:-inset-y-0.5')
  })

  it('sizes the phone search fields, View options and the filter fields from the token', () => {
    const cases: Array<[string, RegExp]> = [
      ['Sidebar/SessionsPage.tsx', /onClick=\{onSearch\}\s*className="flex h-\(--phone-control\) /],
      ['ui/search-bar.tsx', /filled\s*\? 'flex h-\(--phone-control\) /],
      ['ui/search-bar.tsx', /md:min-h-8 pointer-coarse:min-h-9 phone:min-h-\(--phone-control\)'/],
      ['Sidebar/SidebarSectionHeader.tsx', /ACTION_CLASS =\s*'[^']*pointer-coarse:size-9 phone:size-\(--phone-control\)'/],
      ['NewSession/WorkspacePicker.tsx', /aria-label="Filter folders"[\s\S]{0,600}pointer-coarse:h-9 phone:h-\(--phone-control\)/],
      ['composer/RunPicker.tsx', /'h-7 text-sm pointer-coarse:h-9'/],
    ]
    for (const [file, pattern] of cases) expect([file, pattern.test(src(file))]).toEqual([file, true])
  })

  it('grows the Git view tabs and the review tab strip to the phone step, and their bars with them', () => {
    expect(src('ui/tabs.tsx')).toMatch(/sm: '[^']*phone:data-\[orientation=horizontal\]:h-\(--phone-control\)'/)
    expect(src('WorkspacePanel/GitViewToolbar.tsx')).toMatch(/h-\(--spacing-toolbar\)[^"]* phone:h-auto phone:py-1"/)
    expect(css).toMatch(/--phone-control: var\(--oa-phone-control\);\s*\/\*[^*]*\*\/\s*--spacing-tab-bar: calc\(var\(--phone-control\) \+ 0\.5625rem\);/)
  })

  it('makes the status bar 37px on touch so its items are 36px, and carries the server to the bar edges', () => {
    expect(css).toMatch(/--spacing-tab-bar:\s*2\.8125rem;[^}]*--spacing-status-bar:\s*2\.3125rem;/)
    const footer = src('AppFooter.tsx')
    expect(footer).toMatch(/const ITEM =\s*'flex h-6 [^']*pointer-coarse:h-9'/)
    expect(footer).toMatch(/const ICON_ITEM =\s*'flex size-6 [^']*pointer-coarse:size-9'/)
    expect(src('HealthDot.tsx')).toMatch(/'relative flex h-6 [^']*before:absolute before:inset-x-0 before:-inset-y-0\.5 [^']*pointer-coarse:h-9'/)
  })

  it('spreads the chat title over the whole title block, and a server row over its full height', () => {
    expect(src('AgentChatView/AgentChatHeader.tsx')).toMatch(/aria-label="Session info"[\s\S]{0,900}before:absolute before:inset-0 before:-bottom-px/)
    expect(src('phone/PhoneNavBar.tsx')).toMatch(/data-phone-nav-title="" className=\{cn\('relative flex min-w-0 flex-col justify-center self-stretch'/)
    expect(src('AppBackendPanel.tsx')).toMatch(/onOpen && '-my-2\.5 cursor-pointer self-stretch py-2\.5 md:-my-3\.5 md:py-3\.5'/)
  })

  it('keeps Edit prompt and Copy prompt from sharing a target on a phone', () => {
    const bubble = src('AgentView/UserBubble.tsx')
    expect(bubble).toContain("EDIT_HIT_CLASS = 'phone:before:-left-4! phone:before:right-0!'")
    expect(bubble).toContain("COPY_HIT_CLASS = 'phone:before:left-0! phone:before:-right-4!'")
  })

  it('keeps a sheet bar button over the grabber strip, which crossed the top of its target', () => {
    const overlay = src('ui/app-overlay.tsx')
    expect(overlay).toMatch(/data-slot="sheet-grabber"\s*className="absolute inset-x-0 top-0 z-10 /)
    expect(overlay).toMatch(/SHEET_BAR_BUTTON_CLASS = 'relative z-20 touch-hit h-\(--phone-control\) min-w-\(--phone-control\) /)
  })

  it('names the Settings sections on every touch screen, which has no tooltip to show them', () => {
    // The icon rail needs a mouse (or no pointer at all); the labelled list takes every touch screen.
    expect(css).toMatch(/@custom-variant settings-rail \{\s*@media \(max-width: 899px\) and \(pointer: fine\), \(max-width: 899px\) and \(pointer: none\) \{/)
    expect(css).toMatch(/@custom-variant settings-list \{\s*@media \(min-width: 900px\), \(pointer: coarse\) \{/)
    expect(src('SettingsModal.tsx')).not.toMatch(/max-\[899px\]|min-\[900px\]/)
  })
})
