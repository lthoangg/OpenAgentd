/**
 * Phone scale (DESIGN.md → Touch density): on a phone, Apple's sizes: 17px
 * text in rows, buttons, menus, fields and chat, 15px second lines, 13px
 * times, 44px rows and targets (48px in the Android app). Desktop, tablets
 * and narrow mouse windows keep their dense scale. happy-dom does not
 * evaluate media queries, so this guards the rules themselves.
 */
import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { compile } from '@tailwindcss/node'

const read = (path: string) => readFileSync(fileURLToPath(new URL(path, import.meta.url)), 'utf8')
const css = read('../../index.css').replace(/\/\*[\s\S]*?\*\//g, '')

const PHONE = '(pointer: coarse) and (max-width: 767px), (pointer: coarse) and (max-height: 580px)'

// A top-level block (at a line start): the phone variant's own ``@media``
// sits indented inside ``@custom-variant``.
const topLevelAt = (media: string) => {
  const at = css.indexOf(`\n@media ${media} {`)
  return at < 0 ? -1 : at + 1
}

function block(media: string): string {
  const at = topLevelAt(media)
  if (at < 0) return ''
  let depth = 0
  for (let i = css.indexOf('{', at); i < css.length; i++) {
    if (css[i] === '{') depth++
    if (css[i] === '}' && --depth === 0) return css.slice(at, i + 1)
  }
  return ''
}

describe('phone scale', () => {
  const phone = block(PHONE)

  it('has one phone query, the same one useIsMobile reads, on touch only', () => {
    expect(phone).not.toBe('')
    expect(css).toMatch(new RegExp(`@custom-variant phone \\{\\s*@media ${PHONE.replace(/[()]/g, '\\$&')} \\{\\s*@slot;\\s*\\}\\s*\\}`))
  })

  it('sets 17px for UI text and chat, 15px for second lines and code, 13px for times', () => {
    expect(phone).toMatch(/--text-xs:\s*calc\(1\.0625rem \* var\(--oa-phone-scale\)\);/)
    expect(phone).toMatch(/--text-sm:\s*calc\(1\.0625rem \* var\(--oa-phone-scale\)\);/)
    expect(phone).toMatch(/--text-base:\s*calc\(1\.0625rem \* var\(--oa-phone-scale\)\);/)
    expect(phone).toMatch(/--text-subhead:\s*calc\(0\.9375rem \* var\(--oa-phone-scale\)\);/)
    expect(phone).toMatch(/--text-code:\s*calc\(0\.9375rem \* var\(--oa-phone-scale\)\);/)
    expect(phone).toMatch(/--text-meta:\s*calc\(0\.8125rem \* var\(--oa-phone-scale\)\);/)
  })

  it('makes rows, the header and every button 44px, and 48px in the Android app', () => {
    expect(phone).toMatch(/--spacing-list-row:\s*2\.75rem;/)
    expect(phone).toMatch(/--spacing-app-header:\s*2\.75rem;/)
    expect(phone).toMatch(/\[data-slot="button"\]\s*\{\s*min-height:\s*44px;\s*min-width:\s*44px;/)
    expect(phone).toMatch(/html\[data-mobile-shell="android"\]\s*\{\s*--spacing-list-row:\s*3rem;/)
    expect(phone).toMatch(/html\[data-mobile-shell="android"\] \[data-slot="button"\]\s*\{\s*min-height:\s*48px;\s*min-width:\s*48px;/)
  })

  it('grows small icons and inline links to a 44px hit area', () => {
    expect(phone).toMatch(/\.touch-hit::before\s*\{\s*inset:\s*min\(0px, calc\(\(100% - 44px\) \/ 2\)\);/)
    expect(phone).toMatch(/\[data-file-ref\]::before\s*\{\s*inset:\s*calc\(\(100% - 44px\) \/ 2\) 0;/)
  })

  it('keeps Text size: Compact one step down (15px), Large one step up (19px)', () => {
    expect(css).toMatch(/:root\s*\{\s*--oa-text-scale:\s*calc\(13 \/ 12\);\s*--oa-phone-scale:\s*1;/)
    expect(css).toMatch(/:root\[data-text-size="compact"\]\s*\{\s*--oa-text-scale:\s*1;\s*--oa-phone-scale:\s*calc\(15 \/ 17\);/)
    expect(css).toMatch(/:root\[data-text-size="large"\]\s*\{\s*--oa-text-scale:\s*calc\(14 \/ 12\);\s*--oa-phone-scale:\s*calc\(19 \/ 17\);/)
  })

  it('leaves the desktop scale as it was', () => {
    expect(css).toMatch(/--text-xs:\s*calc\(0\.75rem \* var\(--oa-text-scale\)\);/)
    expect(css).toMatch(/--text-meta:\s*calc\(0\.6875rem \* var\(--oa-text-scale\)\);/)
    expect(css).toMatch(/--text-subhead:\s*calc\(0\.6875rem \* var\(--oa-text-scale\)\);/)
    expect(css).toMatch(/--spacing-list-row:\s*1\.75rem;/)
  })
})

describe('phone controls', () => {
  it('draws the switch at the iOS 51×31 on a phone', () => {
    const sw = read('../../components/ui/switch.tsx')
    expect(sw).toContain('phone:h-[31px] phone:w-[51px]')
    expect(sw).toContain('phone:h-[27px]')
    expect(sw).toContain("'w-4 phone:w-[27px]'")
  })

  it('keeps Send a 36px circle on a phone, its touch area grown to 44px', () => {
    const composer = read('../../components/InputComposer.tsx')
    expect(composer).toMatch(/const sendSlotClass =\s*'relative touch-hit [^']*pointer-coarse:size-9'/)
    expect(composer).not.toMatch(/const sendSlotClass =\s*'[^']*phone:size-11/)
  })
})

/**
 * The phone block redeclares ``--text-*`` on ``:root``, so a utility must read
 * the variable. In an ``@theme inline`` block Tailwind writes the value into
 * the utility instead (``text-xs`` → ``calc(0.75rem * …)``) and the phone
 * scale silently does nothing. Compile the real stylesheet and look.
 */
describe('phone type utilities', () => {
  const base = fileURLToPath(new URL('../..', import.meta.url))
  const STEPS = ['text-meta', 'text-subhead', 'text-xs', 'text-sm', 'text-base', 'text-code', 'text-large-title']

  // The variant's query has a comma (portrait or landscape phone). Written as
  // the shorthand, Tailwind split it there and read the landscape half as a
  // selector: `.phone\:size-11 (pointer: coarse) and …`, invalid, so a phone
  // held sideways got none of the phone: utilities.
  it('compiles phone: utilities into one valid rule under both phone queries', async () => {
    const compiler = await compile(read('../../index.css'), { base, onDependency() {} })
    const out = compiler.build(['phone:size-11'])
    expect(out).not.toMatch(/\.phone\\:size-11\s*\(/)
    expect(out.replace(/\s+/g, ' ')).toMatch(
      /@media \(pointer: coarse\) and \(max-width: 767px\), \(pointer: coarse\) and \(max-height: 580px\) \{ \.phone\\:size-11 \{/,
    )
  })

  it('reads the variable the phone block overrides, not an inlined value', async () => {
    const compiler = await compile(read('../../index.css'), { base, onDependency() {} })
    const out = compiler.build(STEPS)
    const utility = (name: string) =>
      (new RegExp(`\\.${name}\\s*\\{([^}]*)\\}`).exec(out)?.[1] ?? '').replace(/\s+/g, ' ').trim()
    for (const name of STEPS) {
      expect({ name, css: utility(name) }).toEqual({
        name,
        css: expect.stringContaining(`font-size: var(--${name})`),
      })
    }
  })

  it('keeps the type scale out of @theme inline', () => {
    const inline = /@theme inline\s*\{[^}]*\}/.exec(css)?.[0] ?? ''
    expect(inline).not.toBe('')
    expect(inline).not.toMatch(/--text-/)
  })

  it('has a 34px large title that follows Text size', () => {
    expect(css).toMatch(/--text-large-title:\s*calc\(2\.125rem \* var\(--oa-phone-scale\)\);/)
  })
})

describe('phone sheets', () => {
  const phone = block(PHONE)

  it('makes a phone\'s modal overlay a full-width sheet with 12px top corners', () => {
    const sheet = /\.app-overlay-modal,[^{]*\{([^}]*)\}/.exec(phone)?.[1] ?? ''
    expect(sheet).toMatch(/left:\s*0;/)
    expect(sheet).toMatch(/right:\s*0;/)
    expect(sheet).toMatch(/bottom:\s*0;/)
    expect(sheet).toMatch(/border-radius:\s*0\.75rem 0\.75rem 0 0;/)
    expect(sheet).toMatch(/padding-bottom:\s*env\(safe-area-inset-bottom/)
  })

  it('outranks the mobile shell\'s app-level card height', () => {
    expect(phone).toContain('html[data-mobile-shell] .app-overlay-modal[data-overlay-level="app"]')
  })

  it('comes after every card rule it overrides', () => {
    const phoneEnd = topLevelAt(PHONE) + phone.length
    expect(css.slice(phoneEnd)).not.toContain('.app-overlay-modal')
  })
})
