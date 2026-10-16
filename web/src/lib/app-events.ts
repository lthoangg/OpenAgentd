/**
 * Window events for chat-shell actions that have no keyboard shortcut.
 *
 * Native menu commands reach shortcut-backed actions by synthesizing the key
 * (``dispatchAppShortcut``); these events cover the rest, so the menu does
 * not need a key binding just to be routable.
 */
export const APP_EVENTS = {
  toggleScheduler: 'oa:toggle-scheduler',
  // Opens without toggling, e.g. on the task ``useUIStore.focusScheduledTask`` named.
  openScheduler: 'oa:open-scheduler',
  openWorkspace: 'oa:open-workspace',
  // The terminal key is matched on the physical Backquote code, which a
  // synthetic key press does not carry.
  openTerminal: 'oa:open-terminal',
  // Opens the sidebar's session search.
  searchSessions: 'oa:search-sessions',
  // A transcript plan-review card asks for the session plan.
  openPlan: 'oa:open-plan',
} as const

export type AppEvent = (typeof APP_EVENTS)[keyof typeof APP_EVENTS]

export function dispatchAppEvent(event: AppEvent): void {
  window.dispatchEvent(new Event(event))
}
