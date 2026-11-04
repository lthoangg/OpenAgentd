/**
 * One name per action (DESIGN.md → Copy): a command with an app shortcut is
 * named in up to three places — the desktop menu (desktop/src-tauri/src/
 * menu.rs), the command palette, and the Keyboard Shortcuts sheet. Each
 * keeps its own case (menus and the palette are Title Case, the sheet is
 * sentence case) and may drop a verb its surface implies ("Toggle", "Open",
 * "Show or hide"), but the words must be the same. Matched by shortcut, so a
 * renamed label anywhere fails here until the others follow.
 */
import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { APP_SHORTCUTS, chordOf, type AppShortcutName } from '@/lib/app-shortcuts'
import { formatChord } from '@/lib/keyboard/chord'
import { shortcutHelp } from '@/lib/keyboard/help'

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8')

/** The words that must agree: case, ellipsis, a hint in parentheses, "the" and the implied verb do not count. */
function words(label: string): string {
  return label
    .toLowerCase()
    .replace(/…/g, '')
    .replace(/\s*\([^)]*\)/g, '')
    .replace(/^(?:toggle|open|show or hide)\s+/, '')
    .replace(/\bthe\s+/g, '')
    .trim()
}

/** The menu.rs accelerator an app shortcut maps to, e.g. ``CmdOrCtrl+Shift+D``. */
function accelerator(name: AppShortcutName): string | null {
  const shortcut = APP_SHORTCUTS[name]
  if ('ctrl' in shortcut || 'alt' in shortcut) return null
  return `CmdOrCtrl+${'shift' in shortcut && shortcut.shift ? 'Shift+' : ''}${shortcut.key}`
}

function menuLabels(): Map<string, string> {
  const labels = new Map<string, string>()
  const src = read('../../../../desktop/src-tauri/src/menu.rs')
  for (const m of src.matchAll(/MenuItem::with_id\(\s*app,\s*\w+,\s*"([^"]+)",\s*\w+,\s*Some\("([^"]+)"\)/g)) {
    labels.set(m[2].replace(/\\\\/g, '\\'), m[1])
  }
  return labels
}

function paletteLabels(): Map<string, string> {
  const labels = new Map<string, string>()
  for (const m of read('../../components/AgentChatView/useAgentCommands.ts').matchAll(/label: '([^']+)'[^\n]*?shortcut: shortcutLabel\(KEYS\.(\w+)/g)) {
    labels.set(m[2], m[1])
  }
  for (const m of read('../../components/AgentChatView/paletteSwitchCommands.ts').matchAll(/label: '([^']+)',[\s\S]{0,300}?shortcut: input\.shortcuts\?\.(\w+)/g)) {
    labels.set(m[2], m[1])
  }
  return labels
}

function helpLabels(): Map<string, string> {
  const entries = shortcutHelp('macos').flatMap((group) => group.entries)
  const labels = new Map<string, string>()
  for (const name of Object.keys(APP_SHORTCUTS) as AppShortcutName[]) {
    const key = formatChord(chordOf(APP_SHORTCUTS[name]), 'macos')
    const entry = entries.find((e) => e.keys.length === 1 && e.keys[0] === key)
    if (entry) labels.set(name, entry.label)
  }
  return labels
}

describe('command labels', () => {
  const menu = menuLabels()
  const palette = paletteLabels()
  const help = helpLabels()

  it('finds the three surfaces (an empty scan cannot pass)', () => {
    expect(menu.size).toBeGreaterThan(10)
    expect(palette.size).toBeGreaterThan(10)
    expect(help.size).toBeGreaterThan(15)
  })

  it('names each shortcut action with the same words everywhere it appears', () => {
    const mismatches: string[] = []
    for (const name of Object.keys(APP_SHORTCUTS) as AppShortcutName[]) {
      const accel = accelerator(name)
      const named = [
        ['menu', accel ? menu.get(accel) : undefined],
        ['palette', palette.get(name)],
        ['help', help.get(name)],
      ].filter((pair): pair is [string, string] => pair[1] !== undefined)
      const distinct = new Set(named.map(([, label]) => words(label)))
      if (distinct.size > 1) mismatches.push(`${name}: ${named.map(([where, label]) => `${where} "${label}"`).join(', ')}`)
    }
    expect(mismatches).toEqual([])
  })
})
