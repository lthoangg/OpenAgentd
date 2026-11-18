// Workspaces, checkouts, git views and workspace files.

export interface WorkspaceValidationResponse {
  workspace: string
}

export interface WorktreeInfo {
  name: string
  directory: string
  branch?: string | null
  managed: boolean
}

export interface WorktreeCreateResponse extends WorktreeInfo {
  source_workspace: string
}

export interface CodingWorkspaceTreeWorktree {
  path: string
  name: string
  managed: boolean
  /** ``folder`` is a subfolder of a checkout, filed under its repository. */
  kind?: 'worktree' | 'folder'
  /**
   * A worktree made outside OpenAgentd (plain ``git worktree add``, another
   * tool): listed, but the app only hides it, never deletes it.
   */
  external?: boolean
  /** The folder no longer exists on disk. */
  missing?: boolean
}

/** A worktree or subfolder gone from the list that still holds sessions. */
export interface CodingWorkspaceTreeFormerCheckout {
  path: string
  name: string
}

export interface CodingWorkspaceTreeRepository {
  path: string
  name: string
  worktrees: CodingWorkspaceTreeWorktree[]
  /**
   * Checkouts removed or gone from disk whose sessions the repository still
   * lists. Absent on a server before this was added.
   */
  former_checkouts?: CodingWorkspaceTreeFormerCheckout[]
  /** Ids of the workspace groups this repository is in (its worktrees share them). */
  group_ids?: string[]
  /** The folder no longer exists on disk. */
  missing?: boolean
  /**
   * The folder is inside a Git working tree. ``false`` for a plain folder:
   * no Changes view, no worktrees. Absent on a server before v3.56.0, which
   * reads as "may be".
   */
  git?: boolean
}

/**
 * A workspace group: a named tag on repositories. Workspaces whose
 * repositories share a group may message each other (`workspace` tool);
 * the brief tells their agents what each repository is for.
 */
export interface WorkspaceGroup {
  id: string
  name: string
  brief: string | null
  /** Picked colour as `#rrggbb`; null (or absent on older servers) derives one from the id. */
  color?: string | null
}

export interface WorkspaceGroupWithMembers extends WorkspaceGroup {
  /** Visible repository paths tagged with the group. */
  members: string[]
}

/**
 * The prebuilt chat workspace, rendered as a pinned sidebar row. It is not a
 * repository: the backend never stores it in `coding_workspaces`, so it has no
 * worktrees and its path is not a valid worktree source.
 */
export interface CodingWorkspaceTreeChat {
  path: string
  name: string
}

export interface CodingWorkspaceTreeResponse {
  repositories: CodingWorkspaceTreeRepository[]
  chat?: CodingWorkspaceTreeChat | null
  groups?: WorkspaceGroup[]
}

export interface WorkspaceBrowseResponse {
  path: string
  parent: string | null
  directories: Array<{ name: string; path: string }>
}

export interface WorkspaceGitDiffResponse {
  workspace: string
  is_git_repo: boolean
  diff: string
  untracked?: string[]
  truncated?: boolean
}

/** One row of ``GET /agent/workspace/git-diff/files``. */
export interface WorkspaceChangedFile {
  path: string
  status: 'A' | 'M' | 'D'
  /** ``null`` for an untracked file past the server's read budget. */
  additions: number | null
  deletions: number | null
}

/** Every changed path, from git's file lists; complete however big the diff. */
export interface WorkspaceChangesResponse {
  workspace: string
  is_git_repo: boolean
  files: WorkspaceChangedFile[]
  /** Changed paths before the 5,000-row cap. */
  total: number
  truncated: boolean
}

export interface WorkspaceStatusResponse {
  workspace: string
  name: string
  is_git_repo: boolean
  branch?: string | null
  dirty?: { staged: number; unstaged: number; untracked: number }
  head?: { sha: string; subject: string; timestamp: number } | null
  /** Local commits not yet pushed to the tracking remote or origin. null when no upstream/origin. */
  commits_ahead?: number | null
  /** Remote commits not yet pulled locally. null when no upstream/origin. */
  commits_behind?: number | null
  /** Origin/upstream branch used for commit counts (e.g. origin/main or origin/branch-A). */
  upstream?: string | null
}

export interface GitCommit {
  sha: string
  short_sha: string
  author_name: string
  author_email: string
  timestamp: number
  subject: string
  body?: string | null
  refs?: string | null
}

export interface WorkspaceGitHistoryResponse {
  workspace: string
  is_git_repo: boolean
  commits: GitCommit[]
  next_cursor?: string | null
}

export interface WorkspaceCommitDiffResponse {
  sha: string
  diff: string
}

export interface CodingWorkspaceFilesResponse {
  workspace: string
  files: WorkspaceFileInfo[]
  truncated: boolean
}

// ── Workspace files (artifacts panel) ────────────────────────────────────────
//
// Flat recursive listing of a session's agent workspace (``.openagentd/agent/{sid}``).
// File bytes are fetched through ``/api/agent/{sid}/media/{path}`` — the same
// proxy that renders inline markdown images.
export interface WorkspaceFileInfo {
  path: string   // POSIX-separated, relative to the workspace root
  name: string   // Basename
  size: number   // Bytes
  mtime: number  // Seconds since epoch
  mime: string   // MIME type (guessed)
  ignored?: boolean // Gitignored; listed after every visible file
  deleted?: boolean // Synthetic client-side marker for git-deleted files
}

export interface WorkspaceFilesResponse {
  session_id: string
  files: WorkspaceFileInfo[]
  truncated: boolean
}

export interface DiscardWorkspaceFileResponse {
  workspace: string
  path: string
  status: string
}

export interface GitUndoResponse {
  workspace: string
  success: boolean
}

export interface GitRevertResponse {
  workspace: string
  sha: string
  success: boolean
}

export interface CodingWorkspaceVisibilityResponse {
  workspace: string
  hidden: boolean
}

/** ``POST /agent/workspace/relocate``: what moved (or, on a dry run, would). */
export interface WorkspaceRelocateResponse {
  from: string
  /** The new folder, resolved. */
  workspace: string
  dry_run: boolean
  /** Top-level sessions under the folder and its worktrees. */
  sessions: number
  scheduled_tasks: number
  worktrees: Array<{ path: string; managed: boolean }>
  /** Names of the groups the repository is in. */
  groups: string[]
  /** The new folder is already a listed workspace: the two merge. */
  merge: boolean
  /** Sessions already at the new folder. */
  target_sessions: number
  moved_worktrees: Array<{ from: string; to: string }>
  /** Git steps that failed; the move itself stands. */
  warnings: string[]
}

export interface WorktreeRemoveResponse {
  removed: boolean
  /** The branch the worktree is on. */
  branch?: string | null
  /** Only a branch OpenAgentd made is deleted, and only when no commit would be lost. */
  branch_deleted?: boolean
  /** Commits on an OpenAgentd branch that no other branch holds. */
  unmerged_commits?: number
}
