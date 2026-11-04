/**
 * Shape returned by ``getToolDisplay`` — the per-tool renderer.
 *
 * Most fields default to "show the tool name and pretty-printed JSON args";
 * a tool only needs to populate the fields where the default is unhelpful.
 */

import type { ReactNode } from 'react'

export interface ToolDisplay {
  /** Header replacing the tool name; arg values are italicised via `<Arg>`. `null` falls back to the tool name. */
  header: ReactNode | null
  /** Plain-text version of the header, uncut (the row's ``data-tool-label``). */
  headerTitle: string | null
  /**
   * The row's tooltip: only what the row does not already show (the shell
   * command's description, a target the header had to cut). Absent: none.
   */
  tooltip?: string | null
  /** Simplified args body; ``null`` hides the args section entirely. */
  formattedArgs: string | null
  /** When set, render args as a code block with this language label. */
  language?: 'bash' | null
  /**
   * Hide the result section entirely.  Useful for tools whose result is
   * already rendered inline in the assistant reply (e.g. ``generate_image``
   * embeds a Markdown image, ``generate_video`` embeds a Markdown video).
   */
  suppressResult?: boolean
}

export type ToolCallState = 'start' | 'running' | 'success' | 'failed'
