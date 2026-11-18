// Skills, slash commands and snippets.
import type { MessageResponse } from './sessions'

export interface SkillSummary {
  name: string
  description: string
  valid: boolean
  error: string | null
  built_in: boolean
  editable: boolean
  source: string
}

export interface SkillDetail {
  name: string
  path: string
  content: string
  description: string
  error: string | null
  built_in: boolean
  editable: boolean
  source: string
}

export interface SkillDeleteResponse {
  name: string
}

export interface SkillListResponse {
  skills: SkillSummary[]
}

export interface CommandSummary {
  name: string
  description: string
  source: string
}

export interface CommandListResponse {
  commands: CommandSummary[]
}

export interface CommandRenderResponse {
  name: string
  content: string
}

export interface SnippetSummary {
  name: string
  description: string
  source: string
}

export interface SnippetListResponse {
  snippets: SnippetSummary[]
}

export interface SnippetRenderResponse {
  name: string
  content: string
}

/**
 * Workspace paths the server's snapshot restore touched during a
 * ``undo`` / ``redo`` command. Empty lists mean the restore had no
 * filesystem effect (or no snapshot was recorded) — the client uses
 * that as a signal to skip the workspace cache invalidation
 * entirely, saving a full ``git diff`` fetch on a 30k-file workspace.
 */
export interface ChangedPaths {
  added: string[]
  modified: string[]
  removed: string[]
}

export interface AgentCommandResponse {
  status: string
  session_id: string
  command: 'continue' | 'compact' | 'undo' | 'redo' | 'redo-all' | 'redo_all'
  message?: MessageResponse
  /**
   * Present on ``undo`` / ``redo`` responses only. The client uses
   * the union of all three buckets to drive a scoped
   * ``coding_workspace_paths`` invalidation — refreshing the diff bodies
   * of just these paths instead of every one on screen.
   */
  changed_paths?: ChangedPaths
  /** ``undo`` / ``redo``: the undone messages left the workspace files as they were. */
  keep_files?: boolean
}
