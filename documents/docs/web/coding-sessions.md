---
title: Coding Sessions UI
description: Coding-mode session restore, workspace sidebar pagination, and reload/error handling.
status: stable
updated: 2026-06-24
---

# Coding sessions UI

**Sources:** `web/src/components/CodingSidebar.tsx`, `web/src/components/TeamChatView/index.tsx`, `web/src/stores/useTeamStore/`, `web/src/stores/cache-invalidation-bridge.ts`, `web/src/queries/useSessionsQuery.ts`, `app/api/routes/team/chat.py`, `app/services/chat_service.py`

## Session restore and New

- `/cockpit` and workspace-backed `/coding` auto-resolve to the latest matching top-level team session, creating an empty persisted session only when none exists. Opening or trusting a workspace resumes its latest session; it is not treated as New.
- Explicit New actions (`Ctrl+N`, topbar `+`, workspace `+`) force creation instead of resolving latest, except when the current session is already empty and idle. Pending model/thinking selections are preserved when an auto-resolve reuses an older session without those fields.
- Queryless `/coding/{session_id}` remains valid. The frontend first uses cached session-list workspace data when available, otherwise loads session detail to recover the persisted workspace, and falls back to the current lead name when the backend omits `agent_name` for empty sessions.
- Empty coding sessions show the workspace status card instead of the old no-agent placeholder; compaction-only history still counts as empty for this view.
- Opening bare `/coding` without a workspace shows the launcher and hides the composer.
- After a session opens or activates, focus returns to the composer so the user can type immediately.

## Sidebar session lists

- The cockpit recent-session list now fetches only normal sessions (`GET /api/team/sessions?mode=normal`) instead of loading a mixed feed and filtering in the browser. This avoids empty-state glitches when the shared session cache was populated from coding-mode navigation.
- Coding session lists are scoped per workspace. Expanded workspaces fetch `GET /api/team/sessions?mode=coding&workspace=...` with a page size of 5.
- The coding sidebar's global repository/session feed likewise fetches only coding sessions (`GET /api/team/sessions?mode=coding`) and keeps a distinct TanStack Query cache key from the cockpit list so normal and coding pagination state cannot overwrite each other.
- Workspace rows expose **Create worktree**. The backend creates git worktrees under `{OPENAGENTD_DATA_DIR}/worktrees/<repo>-<hash>/`, defaults branches to `openagentd/<name>`, saves the new worktree as a coding workspace, and opens a fresh session there. Worktree sidebar titles can be renamed without renaming the git worktree directory. OpenAgentd-managed worktrees can be removed through the worktree API; arbitrary external worktrees are listed but not deleted by OpenAgentd.
- Each main/worktree session list is capped to roughly five rows and fetches the next page when the user scrolls to the bottom of that list.
- Session rows show running indicators from per-session `running` data, not from only the currently selected chat state.
- Collapsed workspaces do not eagerly fetch their own pages; they show running sessions already present in the global session cache.
- New coding sessions appear in the sidebar immediately. They are prepended only into the global cache and the matching workspace cache, while detail caches are ignored by list-only patching. Workspace prepends keep a short stale window so a 5-row list can temporarily show 6 rows instead of immediately dropping the previous fifth row.
- Session titles are editable from the sidebar: double-click a session row or use the pencil action. Saves call `PATCH /api/team/sessions/{id}` and patch the global/workspace/detail session caches in-place.
- Deleting a session selects the next available session when possible instead of attempting to reload the deleted session.
- On mobile-width screens, the workspace files drawer switches to a full-width file preview after file selection; desktop keeps the file tree visible beside the preview.

## Workspace dock file search and review

- The workspace dock exposes file search from the `+` button beside the Changes/file tabs.
- On desktop, file search is a full-viewport modal so it stays centered over the app while the dock remains resizable.
- On mobile, file search is centered inside the workspace panel viewport instead of the browser viewport, keeping it below the app header and safe-area. The mobile search field uses a taller touch target and 16px text to avoid iOS zoom and improve tap ergonomics.
- File preview tabs only show current file content. The old File/Diff toggle is removed.
- The Changes tab keeps git review in place: each changed file expands/collapses inline and shows a diff with hunk headers and standard context lines (3 lines of prefix/suffix context). File and diff content wrap long lines so users only scroll vertically.
- **Git UI state persistence:** The state of the Git feature in the workspace dock (the selected sub-tab like Changes/Commits/Tree, the "All Branches" toggle, which commits are expanded, and which files/diffs are expanded) is persisted per workspace in the browser's local storage. This preserves the developer's exact scroll position and review context when closing/reopening the dock or switching between different workspaces.

## Running and reload states

- Session list/detail/history responses include `running`, derived from the in-memory stream store, so restored active sessions show the chat pending indicator immediately.
- During browser reload/unload, the frontend marks the page as unloading on `beforeunload` and `pagehide`, aborts the active stream, and suppresses only unload-time stream errors. Real active-page `error` events still produce the normal Agent error toast.

## Command palette scope

The command palette omits custom slash commands, Focus Chat Input, and the lead self-switch command. Slash commands remain available from the composer `/` picker, `Ctrl+I` still focuses the composer, and worker-agent view commands remain in the palette.
