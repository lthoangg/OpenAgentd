/**
 * The notch, the pet, the tray popup and the widgets each keep a size or a
 * timing in more than one language (Rust for the window, TypeScript for
 * the page, CSS for the drawing, Swift and Kotlin for the widgets). Nothing
 * shares code across them, so these read the sources and hold the copies
 * to each other.
 */
import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { CANVAS_HEIGHT, CANVAS_WIDTH, EAR_WIDTH, WING_WIDTH } from '@/island/status'
import { DUST_MS, FOLD_MS, JUMP_CROUCH_MS, JUMP_LOOK_MS, LAND_MS, PET_HEIGHT } from '@/pet/state'
import { meterTone } from '@/tray/usage'

const read = (path: string) => readFileSync(fileURLToPath(new URL(`../../../../${path}`, import.meta.url)), 'utf8')

/** The number `pattern` captures in `source`; a pattern that finds nothing fails the test. */
function num(source: string, pattern: RegExp): number {
  const found = pattern.exec(source)?.[1]
  if (found === undefined) throw new Error(`not found: ${pattern}`)
  return Number(found)
}

describe('the notch', () => {
  const css = read('web/src/island/island.css')
  const rust = read('desktop/src-tauri/src/island.rs')

  it('draws its ears and wings at the widths the page measures with', () => {
    expect(num(css, /--island-ear:\s*(\d+)px/)).toBe(EAR_WIDTH)
    expect(num(css, /--island-wing:\s*(\d+)px/)).toBe(WING_WIDTH)
  })

  it('lives in a window the size the page lays out for', () => {
    expect(num(rust, /pub const CANVAS_WIDTH: f64 = ([\d.]+);/)).toBe(CANVAS_WIDTH)
    expect(num(rust, /pub const CANVAS_HEIGHT: f64 = ([\d.]+);/)).toBe(CANVAS_HEIGHT)
  })
})

describe('the pet', () => {
  const css = read('web/src/pet/pet.css')
  const rust = read('desktop/src-tauri/src/pet.rs')

  it('animates for as long as the page waits', () => {
    expect(num(css, /--pet-fold:\s*(\d+)ms/)).toBe(FOLD_MS)
    expect(num(css, /--pet-jump-look:\s*(\d+)ms/)).toBe(JUMP_LOOK_MS)
    expect(num(css, /--pet-jump-crouch:\s*(\d+)ms/)).toBe(JUMP_CROUCH_MS)
    expect(num(css, /--pet-land:\s*(\d+)ms/)).toBe(LAND_MS)
    expect(num(css, /--pet-dust:\s*(\d+)ms/)).toBe(DUST_MS)
  })

  it('is as tall to the shell that places it as to the page that draws it', () => {
    expect(num(rust, /const PET_HEIGHT: f64 = ([\d.]+);/)).toBe(PET_HEIGHT)
  })
})

describe('the tray popup', () => {
  const css = read('web/src/tray/tray.css')
  const popup = read('desktop/src-tauri/src/tray_popup.rs')
  const menu = read('desktop/src-tauri/src/menu.rs')
  const usage = read('desktop/src-tauri/src/usage.rs')

  it('stops growing where its window does', () => {
    expect(num(css, /max-height:\s*(\d+)px/)).toBe(num(popup, /const TRAY_MAX_HEIGHT: f64 = ([\d.]+);/))
  })

  it('refreshes on opening no more often than the native menu does', () => {
    expect(num(popup, /const USAGE_OPEN_REFRESH_GAP: Duration = Duration::from_secs\((\d+)\);/))
      .toBe(num(menu, /const USAGE_TRAY_OPEN_MIN_GAP: Duration = Duration::from_secs\((\d+)\);/))
  })

  it('turns orange and red at the percentages the native menu marks', () => {
    const glyph = /fn status_glyph\(percent: f64\)[\s\S]*?\n}/.exec(usage)?.[0] ?? ''
    const [crit, warn] = [...glyph.matchAll(/percent >= ([\d.]+)/g)].map((m) => Number(m[1]))
    expect([warn, crit]).toEqual([70, 90])
    expect([meterTone(warn - 0.1), meterTone(warn), meterTone(crit - 0.1), meterTone(crit)]).toEqual(['ok', 'warn', 'warn', 'crit'])
    expect(num(usage, /pub const CRITICAL_USAGE_PERCENT: f64 = ([\d.]+);/)).toBe(crit)
  })
})

describe('the widgets', () => {
  it('trust "Needs you" and "Running" for the same time on both phones', () => {
    const swift = read('mobile/ios-widget/Extension/OpenAgentdWidgets.swift')
    const kotlin = read('mobile/android-plugin/android/src/main/java/Widgets.kt')
    const iosMinutes = num(swift, /private let statusFreshFor: TimeInterval = (\d+) \* 60\b/)
    const androidMinutes = num(kotlin, /private const val STATUS_FRESH_MS = (\d+) \* 60_000L/)
    expect(iosMinutes).toBe(30)
    expect(androidMinutes).toBe(iosMinutes)
  })
})
