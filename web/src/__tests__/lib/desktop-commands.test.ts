import { beforeEach, describe, expect, it, mock } from 'bun:test'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const navigate = mock(() => Promise.resolve())
const router = { navigate } as unknown as import('@tanstack/react-router').AnyRouter

import { openNotificationSession } from '@/lib/desktop-commands'
import { takeQuietOpen } from '@/lib/quiet-open'

beforeEach(() => navigate.mockClear())

describe('router coupling', () => {
  it('does not import the router singleton (it would close a cycle through the route tree)', () => {
    // router.ts -> routes/__root.tsx -> desktop-commands -> router.ts, and
    // router.ts -> routes/cockpit.tsx -> AgentChatView -> AppFooter -> router.ts.
    // Both must obtain the router from context instead.
    for (const rel of ['../../lib/desktop-commands.ts', '../../components/AppFooter.tsx']) {
      const src = readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8')
      expect(src).not.toMatch(/from '@\/router'/)
    }
  })
})

describe('shell command coverage', () => {
  const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8')

  // A command the menus emit but the bridge does not know is a dead menu item.
  it('handles every command the app menu, text size items and global shortcuts emit', () => {
    const bridge = read('../../lib/desktop-commands.ts')
    const handled = new Set(Array.from(bridge.matchAll(/case '([a-z_]+)':/g), (m) => m[1]))

    const emitted = new Set<string>()
    for (const match of read('../../../../desktop/src-tauri/src/menu.rs').matchAll(/emit_frontend_command\(app, "([a-z_]+)"\)/g)) emitted.add(match[1])
    // Text Size items emit `text_size_<size>`; the global shortcut emits its own command.
    const sizes = read('../../../../desktop/src-tauri/src/app_menu.rs').match(/TEXT_SIZES: \[\(&str, &str\); 3\] = \[(.*)\];/)?.[1] ?? ''
    for (const match of sizes.matchAll(/\("([a-z]+)",/g)) emitted.add(`text_size_${match[1]}`)
    const shortcut = read('../../../../desktop/src-tauri/src/global_shortcuts.rs').match(/NEXT_NEEDS_YOU_COMMAND: &str = "([a-z_]+)"/)?.[1]
    if (shortcut) emitted.add(shortcut)

    // The scan found the View menu's new items, so an empty or partial match cannot pass.
    for (const id of ['review_panel', 'split_review_panel', 'split_review_panel_down', 'terminal', 'maximize_review_panel', 'reset_layout', 'text_size_compact', 'text_size_large', 'next_needs_you']) {
      expect(emitted.has(id)).toBe(true)
    }
    // Focus Mode is gone from the View menu.
    expect(emitted.has('focus_mode')).toBe(false)
    expect(Array.from(emitted).filter((id) => !handled.has(id))).toEqual([])
  })
})

describe('openNotificationSession', () => {
  it('opens the linked coding session from a desktop notification click', () => {
    openNotificationSession({ sessionId: 'session-123', mode: 'coding' }, router)

    expect(navigate).toHaveBeenCalledWith({
      to: '/$sessionId',
      params: { sessionId: 'session-123' },
    })
  })

  it('ignores malformed payloads', () => {
    openNotificationSession({ sessionId: 'session-456', mode: 'coding' }, router)
    openNotificationSession({ sessionId: 42, mode: 'coding' }, router)

    expect(navigate).toHaveBeenCalledTimes(1)
    expect(navigate).toHaveBeenCalledWith({
      to: '/$sessionId',
      params: { sessionId: 'session-456' },
    })
  })

  it('marks a widget open as quiet, and an OS notification open not', () => {
    openNotificationSession({ sessionId: 'from-island', quiet: true }, router)
    expect(takeQuietOpen('from-island')).toBe(true)
    openNotificationSession({ sessionId: 'from-notification' }, router)
    expect(takeQuietOpen('from-notification')).toBe(false)
    expect(navigate).toHaveBeenCalledTimes(2)
  })

  it('opens a click the shell repeats while the window loads once, and a new click again', () => {
    // The shell resends a click a few times so a loading window still gets
    // it; a repeat arriving after the person moved on must not pull them back.
    for (let i = 0; i < 5; i++) openNotificationSession({ sessionId: 'clicked', id: 9001 }, router)
    expect(navigate).toHaveBeenCalledTimes(1)
    openNotificationSession({ sessionId: 'clicked', id: 9002 }, router)
    expect(navigate).toHaveBeenCalledTimes(2)
  })
})
