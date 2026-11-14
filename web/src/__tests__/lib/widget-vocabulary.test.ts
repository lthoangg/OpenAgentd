/**
 * The home-screen widgets are drawn natively (Swift, Kotlin), so nothing
 * shares code with the app. These read the native sources and hold them to
 * the app's status words and to each other.
 */
import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { STATUS } from '@/lib/status'
import { WIDGET_INBOX_LIMIT } from '@/lib/widget-snapshot'

const read = (path: string) => readFileSync(fileURLToPath(new URL(`../../../../mobile/${path}`, import.meta.url)), 'utf8')

const SWIFT = read('ios-widget/Extension/OpenAgentdWidgets.swift')
const KOTLIN = read('android-plugin/android/src/main/java/Widgets.kt')
const STRINGS = read('android-plugin/android/src/main/res/values/openagentd_widget_strings.xml')
const DAY = read('android-plugin/android/src/main/res/values/openagentd_widget_colors.xml')
const NIGHT = read('android-plugin/android/src/main/res/values-night/openagentd_widget_colors.xml')
const RUST = read('src-tauri/src/widgets.rs')

function androidString(name: string): string | undefined {
  return new RegExp(`<string name="openagentd_widget_${name}">([^<]*)</string>`).exec(STRINGS)?.[1]
}

function androidColor(xml: string, name: string): string | undefined {
  return new RegExp(`<color name="openagentd_widget_${name}">#([0-9A-Fa-f]{6})</color>`).exec(xml)?.[1]?.toUpperCase()
}

/** `static let needsText = Color(light: 0x873E05, dark: 0xF5C27A)`. */
function swiftColor(name: string): { light: string; dark: string } | undefined {
  const match = new RegExp(`static let ${name} = Color\\(light: 0x([0-9A-F]{6}), dark: 0x([0-9A-F]{6})\\)`).exec(SWIFT)
  return match ? { light: match[1]!, dark: match[2]! } : undefined
}

describe('widget status words', () => {
  it('a session at work reads "Running", as in the sidebar', () => {
    expect(androidString('running')).toBe(STATUS.running.label)
    expect(SWIFT).toContain(`Pill(text: "${STATUS.running.label}"`)
    expect(SWIFT).not.toContain('"Working"')
    expect(STRINGS).not.toContain('>Working<')
  })

  it('a session waiting on you reads "Needs you"', () => {
    expect(androidString('needs_you')).toBe(STATUS.needsYou.label)
    expect(SWIFT).toContain(`Pill(text: "${STATUS.needsYou.label}"`)
  })

  it('says to open the app before anything was saved, on both phones', () => {
    for (const text of ['Open OpenAgentd to load your sessions', 'Open OpenAgentd to load your tasks']) {
      expect(SWIFT).toContain(`"${text}"`)
      expect(STRINGS).toContain(`>${text}<`)
    }
    expect(KOTLIN).toContain('R.string.openagentd_widget_inbox_unloaded')
    expect(KOTLIN).toContain('R.string.openagentd_widget_tasks_unloaded')
  })
})

describe('widget pill colours', () => {
  const pills = [
    { android: 'needs', swift: 'needs' },
    { android: 'running', swift: 'running' },
    { android: 'idle', swift: 'idle' },
    { android: 'failed', swift: 'failed' },
  ]

  it.each(pills)('the $android pill has the same text and fill on Android as on iOS', ({ android, swift }) => {
    const text = swiftColor(`${swift}Text`)
    const fill = swiftColor(`${swift}Background`)
    expect(text).toBeDefined()
    expect(fill).toBeDefined()
    expect(androidColor(DAY, `${android}_text`)).toBe(text?.light)
    expect(androidColor(NIGHT, `${android}_text`)).toBe(text?.dark)
    expect(androidColor(DAY, `${android}_bg`)).toBe(fill?.light)
    expect(androidColor(NIGHT, `${android}_bg`)).toBe(fill?.dark)
  })

  it.each(pills)('Android draws the $android pill with its own text colour', ({ android }) => {
    expect(KOTLIN).toContain(`R.color.openagentd_widget_${android}_text`)
  })
})

describe('widget inbox size', () => {
  it('is the same number of rows in the app, the shell and the Android layout', () => {
    expect(/pub const INBOX_LIMIT: usize = (\d+);/.exec(RUST)?.[1]).toBe(String(WIDGET_INBOX_LIMIT))
    expect(KOTLIN.match(/^\s+Row\(R\.id\.openagentd_widget_inbox_row\d/gm)?.length).toBe(WIDGET_INBOX_LIMIT)
  })
})
