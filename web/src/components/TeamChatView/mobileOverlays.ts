/**
 * mobileOverlays — the single-overlay rule for the mobile chat layout.
 *
 * On mobile every large surface (session sidebar, chat-actions menu,
 * coding workspace panel, session settings, scheduler, todos, files panel,
 * command palette) is a full-screen or near-full-screen overlay. Two open
 * at once is always a layering bug, so opening any one closes the rest.
 *
 * ``useUIStore`` enforces exclusion among scheduler / capabilities / palette
 * and ``useEdgeSwipe`` enforces it among the drawers; this module is the
 * cross-island bridge. The logic is a pure function so it can be unit-tested
 * without rendering ``TeamChatView``.
 */

export type MobileOverlay =
  | 'sidebar'
  | 'actions'
  | 'coding-panel'
  | 'todos'
  | 'files'
  | 'terminal'
  | 'scheduler'
  | 'capabilities'
  | 'palette'

/** The three overlays owned by the edge-swipe drawer controller. */
const DRAWER_OVERLAYS: MobileOverlay[] = ['sidebar', 'actions', 'coding-panel']

const ALL_OVERLAYS: MobileOverlay[] = [
  ...DRAWER_OVERLAYS,
  'todos',
  'files',
  'terminal',
  'scheduler',
  'capabilities',
  'palette',
]

/**
 * Given the overlay being opened (``keep``), return the set of overlays that
 * must be closed. Drawers are treated as a group: opening a drawer keeps the
 * other drawers' close to ``useEdgeSwipe`` (so this returns only the
 * non-drawer overlays for a drawer ``keep``), while opening a non-drawer
 * overlay closes every drawer too.
 */
export function overlaysToClose(keep: MobileOverlay): MobileOverlay[] {
  const keepIsDrawer = DRAWER_OVERLAYS.includes(keep)
  return ALL_OVERLAYS.filter((overlay) => {
    if (overlay === keep) return false
    // When opening a drawer, leave sibling-drawer teardown to useEdgeSwipe.
    if (keepIsDrawer && DRAWER_OVERLAYS.includes(overlay)) return false
    return true
  })
}
