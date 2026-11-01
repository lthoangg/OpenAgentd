/**
 * The command palette wired to the app's data: its Sessions group. Mounted
 * only while the palette is open, so the session queries (and the router
 * hook) cost nothing the rest of the time.
 */
import { CommandPalette } from '../CommandPalette'
import type { CommandPaletteProps } from '../CommandPalette'
import { usePaletteSessions } from './usePaletteSessions'

interface PaletteHostProps extends Omit<CommandPaletteProps, 'sessions'> {
  /** The open session, left out of the Sessions group. */
  sessionId: string | null
}

export function PaletteHost({ sessionId, ...palette }: PaletteHostProps) {
  const sessions = usePaletteSessions({ currentSessionId: sessionId })
  return <CommandPalette {...palette} sessions={sessions} />
}
