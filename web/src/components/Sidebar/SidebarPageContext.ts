import { createContext, useContext } from 'react'

/**
 * Whether the sidebar is drawn as the phone's Sessions screen (``page``).
 * Session rows are rendered from many places (the tree, Pinned, the flat
 * views), so they read this instead of every list threading a prop down.
 * ``null`` (the default) is the drawer and the desktop sidebar: no swipe.
 */
export interface SidebarPageState {
  /**
   * Sessions is the screen on top. A chat pushed over it (or any sheet) turns
   * this off, so rows cannot be swiped and a revealed row shuts.
   */
  active: boolean
}

export const SidebarPageContext = createContext<SidebarPageState | null>(null)

export function useSidebarPage(): SidebarPageState | null {
  return useContext(SidebarPageContext)
}
