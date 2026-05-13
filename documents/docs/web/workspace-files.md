---
title: Workspace Files Panel
description: Right-side drawer for browsing, previewing, and downloading agent-generated files with live invalidation.
status: stable
updated: 2026-05-12
---

# Workspace Files panel

A right-side drawer that lets users browse, preview, and download every file
the agent has written into the session workspace (`workspace_dir(session_id)`
— see [`configuration.md`](../configuration.md#sandbox)). Opened from the "Files" button in the team
chat header, via `Ctrl+F`, or from the Command Palette
(*Toggle Workspace Files*).

---

## Overview

The panel is the UI for `GET /api/team/{session_id}/files` — see
[`documents/docs/api/index.md`](../api/index.md#workspace-file-listing) for
the endpoint contract. File **listings** come from `/files`; file **bytes**
are fetched on demand from the media proxy (`/media/{path}`).

Normal sessions list the per-session workspace. `/coding` uses **Files & Diff** for the selected project: a recursive tree plus current git diff. New folders require a trust confirmation before opening, and `/coding` restores the last opened workspace from local browser storage. The coding session list shows a small running indicator on the active session while that turn is streaming. Dot entries, common generated directories, and root `.gitignore` matches are hidden in both views. Large git diffs are capped and marked as truncated.

```
WorkspaceFilesPanel.tsx                (right drawer, w-[min(960px,95vw)])
  ├── Header                           (back button on mobile + title + Refresh + Close)
  ├── Tree pane                        (grouped by directory)
  │     └── TreeGroup → FileRow        (icon + name + size)
  └── PreviewArea
        ├── Header bar                 — file path/MIME + Download +
        │                                CopyContentsButton (text only)
        ├── ImagePreview               — images (inline + lightbox on click)
        ├── TextPreview                — raw content in plain monospace <pre>
        └── BinaryPreview              — "Download" / "Open in new tab" fallback
```

**Desktop:** tree pane is a fixed `w-[260px]` left column; preview fills the rest.
**Mobile:** master/detail — tree and preview are mutually exclusive full-width panes. Selecting a file switches to the preview pane; the `ArrowLeft` icon button in the header returns to the tree. See [`mobile.md`](./mobile.md).

---

## Opening the panel

| Trigger | Notes |
|---------|-------|
| **"Files" button** in the chat header | Next to the **Agents** button; disabled when no session is active. |
| **`Ctrl+F`** | Toggles the panel. In `/coding`, opens **Files & Diff** for the selected workspace. |
| **Command Palette** | Normal: *Toggle Workspace Files*. Coding: *Open Files & Diff*. |

The right-side panels animate on enter/exit. Clicking outside **Files & Diff** closes it.

---

## Data flow

### Listing query

`useWorkspaceFilesQuery(sessionId)` is a thin TanStack Query hook over
`listWorkspaceFiles(sessionId)`. Query key:
`queryKeys.team.files(sessionId)`. Enabled only when `sessionId` is set.

### Live invalidation

`useTeamStore.ts` listens for `tool_end` SSE events and invalidates the
workspace files query when the finished tool is **mutating** and its path is
**not** a memory path:

```ts
// Pseudocode from useTeamStore
const WORKSPACE_MUTATING_TOOLS = new Set(['write', 'edit', 'rm'])

if (WORKSPACE_MUTATING_TOOLS.has(toolName)) {
  queryClient.invalidateQueries({ queryKey: queryKeys.team.files(sid) })
}
```

No new SSE event was introduced.

### Manual refresh

The **Refresh** button in the panel header calls
`queryClient.invalidateQueries({ queryKey: queryKeys.team.files(sid) })`
directly — useful when the agent performs filesystem writes through `shell`
(which the heuristic does not track).

---

## File classification

`kindOf(file)` returns `'image' | 'text' | 'binary'` based on extension first,
MIME type second:

| Kind | Matches | Preview |
|------|---------|---------|
| `image` | ext ∈ {`png`, `jpg`, `jpeg`, `gif`, `webp`, `svg`, `bmp`} OR `mime` starts with `image/` | Inline `<img>`, click opens `ImageLightbox` |
| `text` | ext ∈ `TEXT_EXTENSIONS` (md, py, ts, json, yaml, csv, …) OR `mime` starts with `text/` OR `mime === 'application/json'` | Raw content in a plain monospace `<pre>` |
| `binary` | everything else | Download / Open-in-new-tab buttons |

SVG is classified as `image` (prefer the visual over the source view).

---

## Previews

### Image preview

Renders via `workspaceMediaUrl(sessionId, path)` (i.e. the `/media/` proxy),
so the same path-traversal guard applies. The thumbnail has
`cursor-zoom-in`; clicking opens the shared `ImageLightbox` component
(full-screen, body-scroll locked, Esc / backdrop close).

### Text preview

Displays the raw file content as-is in a plain `<pre>` with a monospace
font — no markdown rendering, no syntax highlighting, no transformation.
What's on disk is exactly what appears.

**Size cap — 512 KB.** Larger files show a "File too large to preview"
notice with the size and the limit. No request is fired. The Download
button in the preview header is still available via the media proxy. The
Copy button (see below) is disabled with a tooltip explaining the limit.

### Binary preview

Fallback for anything not classified as image or text. Shows the MIME type
and size plus two actions:

- **Open in new tab** — `<a target="_blank">` to the media proxy URL.
- **Download** — same URL with `download` attribute set to the basename.

### Preview header actions

The header bar above each preview (file path + size + MIME) carries two
icon-only actions, both anchored to the right:

- **Download** — `<a download>` pointing at the media proxy URL. Always
  shown, regardless of file kind.
- **Copy contents** (`CopyContentsButton`) — fetches the file via the media
  proxy and writes the response text to `navigator.clipboard`. **Only
  rendered for `kind === 'text'`** — copying binary or image bytes to the
  clipboard isn't useful and could OOM the browser. The button:
  - Is disabled with a "File too large to copy" tooltip when the file
    exceeds the same 512 KB cap as `TextPreview` (no fetch is fired in that
    case).
  - Shows a spinner (`Loader2`) while the fetch is in flight.
  - Flips to a green `Check` for ~1.5s on success (matches the copy-button
    pattern used by `ToolCall` / `ToolResult` / `AssistantTurnFooter`).
  - Swallows fetch and clipboard errors (best-effort; the user can fall
    back to Download).

`CopyContentsButton` is exported as a named export from
`WorkspaceFilesPanel.tsx` so it can be tested in isolation — see
`web/src/__tests__/components/WorkspaceFilesPanel.copy.test.tsx` (9 tests
covering basic rendering, happy path, URL building for nested paths,
success-state flip, the size cap, and fetch/clipboard failure modes).

---

## Tree grouping

The API returns a flat, lexicographically-sorted list. `groupByDir(files)`
splits each `path` on the last `/` and buckets by directory:

- Root (`''`) bucket is rendered first as `/`.
- Other buckets are sorted alphabetically and labelled with their full POSIX
  prefix (e.g. `output/charts/2025`) — no recursive tree, just one level of
  headers. Simpler to reason about, and agents don't nest deeply in practice.

Each `FileRow` shows a type-aware icon (`FileImage` / `FileCode` /
`FileText` / generic `File`), the basename in monospace, and the size via
`formatBytes()`.

---

## Empty / truncated states

| Condition | UI |
|-----------|----|
| Workspace dir does not exist | Empty state — "No files yet" with a hint that agents will populate it. |
| Workspace exists but is empty | Same empty state. |
| Listing `truncated: true` | Footer note — "Showing first 500 files. Some entries hidden." |
| Query error | Error state with the HTTP status and a Retry button. |

---

## Accessibility

- Drawer is rendered as a `<aside>` with `role="complementary"` and an
  accessible label (`aria-label="Workspace files"`).
- Esc closes the drawer (handled via `useKeyboardShortcuts`).
- Tree buttons are real `<button>` elements with `title={file.path}` so the
  full relative path is visible on hover.
- Lightbox `onClose` restores focus to the thumbnail.

---

## Related

- [API reference — workspace file listing](../api/index.md#workspace-file-listing)
- [API reference — media proxy](../api/index.md#media-proxy)
- [`documents/docs/configuration.md` — session path helpers](../configuration.md#session-path-helpers-appcorepathspy)
