/**
 * The desktop menu bar lists the in-app shortcuts beside its items
 * (desktop/src-tauri/src/menu.rs). The web handler claims the key first, so
 * a menu accelerator that drifts from APP_SHORTCUTS shows one key in the menu
 * while another one works. This reads the Rust source and holds the two
 * tables together.
 */
import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { APP_SHORTCUTS, type AppShortcut, type AppShortcutName } from '@/lib/app-shortcuts'

const menuSource = readFileSync(fileURLToPath(new URL('../../../../desktop/src-tauri/src/menu.rs', import.meta.url)), 'utf8')

/** `pub const MENU_X: &str = "x";` → { MENU_X: 'x' } */
function menuIds(source: string): Map<string, string> {
  const ids = new Map<string, string>()
  for (const match of source.matchAll(/pub const (MENU_\w+): &str = "([^"]+)";/g)) ids.set(match[1]!, match[2]!)
  return ids
}

/** Menu item id → its accelerator, for every item that has one. */
function menuAccelerators(source: string): Map<string, string> {
  const ids = menuIds(source)
  const accelerators = new Map<string, string>()
  const item = /MenuItem::with_id\(\s*app,\s*(MENU_\w+),\s*"[^"]*",\s*\w+,\s*Some\("((?:[^"\\]|\\.)+)"\)/g
  for (const match of source.matchAll(item)) {
    const id = ids.get(match[1]!)
    if (!id) throw new Error(`${match[1]} has no id constant`)
    // The Rust literal escapes its backslash: "CmdOrCtrl+\\" is ⌘\.
    accelerators.set(id, match[2]!.replace(/\\(.)/g, '$1'))
  }
  return accelerators
}

/** The accelerator Tauri would need for an in-app shortcut. */
function acceleratorOf(shortcut: AppShortcut): string {
  const modifiers = [shortcut.ctrl ? 'Ctrl' : 'CmdOrCtrl', shortcut.shift && 'Shift', shortcut.alt && 'Alt'].filter(Boolean)
  return [...modifiers, shortcut.key].join('+')
}

/** Menu items that run an in-app shortcut, by the shortcut they run. */
const MENU_SHORTCUTS: Record<string, AppShortcutName> = {
  settings: 'settings',
  new_session: 'newSession',
  open_workspace: 'openWorkspace',
  quick_open: 'quickOpen',
  command_palette: 'commandPalette',
  switch_workspace: 'switchWorkspace',
  workspace_sessions: 'workspaceSessions',
  toggle_sidebar: 'sidebar',
  review_panel: 'workspaceFiles',
  split_review_panel: 'splitDock',
  split_review_panel_down: 'splitDockDown',
  maximize_review_panel: 'maximizeDock',
  agent_capabilities: 'sessionSettings',
}

/** Keys only the native shell handles: the page has no binding for them. */
const NATIVE_ONLY = new Set(['quit', 'new_window', 'zoom_in', 'zoom_out', 'zoom_reset'])

describe('desktop menu accelerators', () => {
  const accelerators = menuAccelerators(menuSource)

  it('reads the menu source', () => {
    expect(accelerators.size).toBeGreaterThanOrEqual(Object.keys(MENU_SHORTCUTS).length + NATIVE_ONLY.size)
  })

  it.each(Object.entries(MENU_SHORTCUTS))('%s shows the key the page binds (%s)', (id, name) => {
    expect(accelerators.get(id)).toBe(acceleratorOf(APP_SHORTCUTS[name]))
  })

  it('gives every accelerated menu item an in-app shortcut or marks it native-only', () => {
    const unclassified = [...accelerators.keys()].filter((id) => !(id in MENU_SHORTCUTS) && !NATIVE_ONLY.has(id))
    expect(unclassified).toEqual([])
  })

  it('lets no native-only key shadow an in-app shortcut', () => {
    const inApp = new Set(Object.values(APP_SHORTCUTS).map(acceleratorOf))
    const shadowing = [...NATIVE_ONLY].filter((id) => inApp.has(accelerators.get(id) ?? ''))
    expect(shadowing).toEqual([])
  })
})
