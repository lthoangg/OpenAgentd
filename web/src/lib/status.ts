/**
 * One status vocabulary (DESIGN.md → Status). A state reads with the same
 * word and the same tone on every surface: the sidebar, Scheduled tasks,
 * subagents, MCP servers, providers, Usage.
 *
 * Colour is kept for what needs a look: Needs you is orange, Failed is red,
 * and green means healthy (Ready, Connected). A finished state (Done,
 * Stopped, Paused) is quiet text, and a live one (Running, Starting…) spins.
 */
import type { ChipTone } from '@/components/ui/chip'

export interface StatusView {
  label: string
  tone: ChipTone
  /** Live: the chip shows a spinner instead of a dot. */
  spinner?: true
}

export const STATUS = {
  needsYou: { label: 'Needs you', tone: 'warning' },
  needsSignIn: { label: 'Needs sign-in', tone: 'warning' },
  running: { label: 'Running', tone: 'info', spinner: true },
  starting: { label: 'Starting…', tone: 'info', spinner: true },
  done: { label: 'Done', tone: 'neutral' },
  stopped: { label: 'Stopped', tone: 'neutral' },
  paused: { label: 'Paused', tone: 'neutral' },
  scheduled: { label: 'Scheduled', tone: 'neutral' },
  idle: { label: 'Idle', tone: 'neutral' },
  inUse: { label: 'In use', tone: 'neutral' },
  off: { label: 'Off', tone: 'neutral' },
  failed: { label: 'Failed', tone: 'error' },
  error: { label: 'Error', tone: 'error' },
  ready: { label: 'Ready', tone: 'success' },
  connected: { label: 'Connected', tone: 'success' },
} as const satisfies Record<string, StatusView>
