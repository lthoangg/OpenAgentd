---
title: Tool Call & Result Rendering
description: Inline tool-call rows with per-tool summaries, codeblock-style args/result panels, and custom renderers.
status: stable
updated: 2026-06-23
---

# Tool Call & Result Rendering

Inline rendering for `ToolCall` blocks: a compact `{Tool Name}: {summary}` header, expandable codeblock-style args/result panel, and tool-aware result renderers.

---

## Overview

Each tool call renders as a lightweight inline row in `ToolCall/index.tsx`. Collapsed rows have no enclosing card or background; expandable rows reveal a single bordered details container below the header. Identity is carried by a humanized tool label plus a tool-specific one-line summary, or just the tool label as a fallback.

The **header** and **arguments** section are customised per tool via `getToolDisplay()`. The **result** section is rendered by `ToolResult.tsx`, which picks a renderer based on `toolName`.

**Spacing:** `ToolCall` does not set its own inter-block spacing — that is owned by the parent container (`space-y-1` / `space-y-1.5` / `space-y-2` depending on the view).

```
ToolCall/index.tsx                  (inline row + header + expand/collapse)
  ├── formatToolLabel()             (custom_tool → Custom Tool)
  ├── Arg                           (marks argument values in summaries)
  ├── getToolDisplay()              (per-tool summary ReactNode & args formatting)
  ├── displayText.ts                (display-only truncation/size summaries)
  └── ToolResult.tsx                (result section dispatcher)
        ├── WebSearchResult         — web_search
        ├── ShellResult             — shell
        ├── FileListResult          — ls, glob, grep
        ├── FileReadResult          — read
        ├── TeamMessageResult       — team_message
        ├── TeamManageResult        — team_manage
        └── GenericResult           — everything else (bg, web_fetch, date,
                                       write, edit, rm, skill, math, …)
```

---

## Header Row

The collapsed header is a single flex row:

```
Shell: Run unit tests [chevron]
```

- **Tool label** — humanized from the backend name (`generate_image` → `Generate Image`), rendered bold in mono text.
- **Summary** — optional per-tool `ReactNode` from `getToolDisplay()`, rendered after `: ` in normal weight. When no custom summary exists, only the tool label is shown.
- **Chevron** (`ChevronRight`, 13px, `--color-text-muted`) — rendered only when the block has expandable details; rotates 90° when expanded. It sits after the summary so the label and details affordance read as one phrase.
- **Duration** — running rows show a client-side elapsed timer; completed rows show persisted `duration_ms`, restored after reload.
- **Running state** — running rows pulse the header text; completed/failed state is represented by the result content rather than extra header badges.

The whole header is a `<button>` so the entire phrase is the click target. Rows with no details use `cursor-default` and do not show a chevron.

### Argument Values (`<Arg>`)

Inside the summary, wrap only the **argument value** with `<Arg>` so it can be styled consistently while the verb/framing text stays normal. `<Arg>` currently renders a plain span; the visual distinction comes from the bold tool label versus normal summary weight. For example:

```tsx
// summary produced for `read`:
<Arg>agent_loop.py</Arg>
// renders in the full header as: Read: agent_loop.py
```

Every custom header case returns both a `ReactNode` (for display) and a plain-string `headerTitle` (used for the `title="…"` tooltip when the header is truncated, and for `aria-label`). HTML attributes can't accept ReactNodes, hence the parallel string.

### Line Change Counts

For file-modifying tools (`edit`, `patch`, and `write`), the header displays line change counts (`+` and `-`) in green and red next to the summary:

```
Edit: main.py +5 -2
```

These stats are calculated dynamically from the tool arguments using `getDiffStats()`.

### Expandable details panel

When expanded, the args and/or result sections slide open below the header inside one codeblock-style container:

- The container uses `surface-raised`, `rounded-md`, `border border-(--color-border)`, and `bg-(--bg-card)`, matching markdown codeblock chrome.
- For file-modifying tools (`edit`, `patch`, and `write`), the raw arguments and results are hidden. Instead, an inline Git-like **Diff View** (`DiffView.tsx`) is rendered directly inside the container, filling it completely without nested borders or padding. Completed `edit`, `patch`, and file `rm` calls use tool-result metadata for line-aware stats; multi-hunk patches reset numbering per hunk. Each file diff owns its scroll region (`max-h-80 overflow-auto`), with a local `top-0` sticky file header that remains clickable to collapse the diff.
- **LSP diagnostics** (coding mode): when a `write`/`edit`/`patch` result carries a `[LSP Diagnostics]` block, `parseLspDiagnostics()` strips it from the raw text and `LspDiagnosticsView` renders it as a compact, color-coded `ERR` / `WARN` strip beneath the diff, with a `+N more` overflow line for the per-file cap. The backend that produces the block is documented in [`../configuration/lsp.md`](../configuration/lsp.md).
- For other tools, each section has a header strip (`bg-(--bg-key)`, bottom divider) with an uppercase 10px mono label (`arguments` / `terminal` / `output` / `result`) and a copy button when applicable.
- Generic result and non-shell arguments content use a standard scroll behavior (max-height of 10 lines with vertical scroll); live and terminal output use their own scrollable max heights.

### Display-size guardrails

Tool rows intentionally distinguish **model-visible content** from **UI-visible content**. Some tool payloads must remain available to the agent (for example a loaded skill body), but showing them verbatim in the cockpit is noisy and can make the browser retain large strings. The frontend therefore applies display-only guardrails:

- `displayText.ts` provides `truncateForDisplay()` for result/read rendering and `summarizeText()` for large argument bodies.
- Live tool output kept in the frontend stream state is capped to recent output before rendering.
- `write` arguments show a line/size summary for `content` rather than the full file body.
- `skill` suppresses the result panel; the loaded instructions still reach the model.
- Generic, shell, file-list, and read result renderers truncate very large displayed text with a `... display truncated ...` marker.

These display caps do not replace backend context controls such as `ToolResultOffloadHook` or shell/bg output truncation; they prevent UI bloat even when a result is useful or required in model context.

---

## Custom ToolCall display

**File:** `web/src/components/ToolCall/display.tsx` — `getToolDisplay(name, args) → ToolDisplay`

```ts
interface ToolDisplay {
  header: ReactNode | null       // summary JSX shown after "Tool Label: ";
                                 // null = show only the tool label
  headerTitle: string | null     // plain-string mirror for title + aria-label
  formattedArgs: string | null   // simplified args body; null = hide args section
  language?: 'bash' | null       // 'bash' → render formattedArgs as a code block
  suppressResult?: boolean       // true → hide the result section entirely
                                 // (used by `generate_image` / `generate_video`,
                                 //  whose result markdown is already rendered
                                 //  inline in the assistant reply)
}
```

Verbs are **deterministic** (no randomised phrase pools). Argument values shown in brackets below are wrapped with `<Arg>`.

| Tool | Header | Expanded args | Args label |
|------|--------|---------------|------------|
| `date` | tool name | hidden | — |
| `shell` | *[description]* (falls back to tool name if empty) | command string as bash block with non-selectable `$ ` prefix | `bash` |
| `web_search` | *["query"]* | hidden | — |
| `web_fetch` | *[domain]* (`www.` stripped) | hidden | — |
| `write` | *[filename]* | `content: {N} lines · {size}` summary while running; completed calls render inline Git-like Diff View (all lines added) | `arguments` before completion |
| `read` | *[filename]* — range suffix ` [start:end]` when `offset`/`limit` set | hidden | — |
| `edit` | *[filename]* | rendered as an inline Git-like Diff View | — |
| `rm` | *[filename]* | hidden | — |
| `ls` | `workspace` (default path) or *[path]* | hidden | — |
| `glob` | *[pattern]* ` in {dir}` ` (by name)` (optional suffixes) | hidden | — |
| `grep` | *[pattern]* ` in {dir}` ` ({include})` (optional suffixes) | hidden | — |
| `remember` | `Saving to memory…` | `[category] key: value` per item | `arguments` |
| `forget` | `Removing from memory…` | `category: key` per item | `arguments` |
| `recall` | `Checking memory…` | `category: key` filter, or hidden if empty | `arguments` |
| `skill` | *[skill_name]* | hidden; result panel suppressed because instructions are model context, not UI detail | — |
| `note` | `Recording note…` | note `content` only (no JSON wrapper) | `arguments` |
| `todo_manage` | Action summary, e.g. `Creating todo: `*[content]*, `Updating `*[N todos]*`…`, `Reading todos…` | simplified action list for create/update/batches; hidden for read/claim/delete | `arguments` when shown |
| `schedule_task` | Action summary, e.g. `Scheduling `*[name]*, `Listing scheduled tasks…`, `Pausing scheduled task `*[slug]* | schedule and prompt details for create; hidden for list/pause/resume/delete/trigger | `arguments` when shown |
| `bg` | Action-based — e.g. `Listing background processes…`, `Checking process `*[pid]*`…`, `Reading output of process `*[pid]*`…`, `Stopping process `*[pid]*`…`, `Managing background process…` | hidden | — |
| `team_message` | `Preparing message…` (pending, no args yet) → Messaging *[recipients]* (joined by `, `, truncated at 60 chars) | message `content` only (no JSON wrapper) | `arguments` |
| `team_manage` | `Spawning` *[members]* or `Dismissing` *[members]* | hidden | — |
| `generate_image` | Painting *[filename]* (normalised: any trailing extension stripped, `.png` appended to match the backend `_sanitise_filename`), or `Painting an image…` when filename is absent | `prompt` string only (`images: …` line prepended in edit mode) | `arguments` |
| `generate_video` | **Extension mode:** `Extending [filename]` / `Extending a video…`. **Other modes:** `Filming [filename]` / `Filming a video…`. Header switches on `extend_video` being set. | `extend_video` / `first_frame` / `last_frame` / `references` input lines (when set) prepended to the `prompt` | `arguments` |

> Both `generate_image` and `generate_video` set `suppressResult: true` — their markdown return values (`![prompt](file.png)` / `![prompt](file.mp4)`) are already rendered inline in the assistant reply, so the tool-call accordion does not repeat them. The `.mp4` path is rendered as `<video controls>` by `MarkdownVideo` (see [`docs/agent/tools.md#multimodalities-multimodalities`](../agent/tools.md#multimodalities-multimodalities)).

All other tools use the default: humanized tool label as the header, pretty-printed JSON as args, label `arguments`. Tools called with an empty `{}` args object hide the args section and are not expandable. Additionally, any stringified JSON fields inside the arguments are recursively parsed and displayed as formatted JSON for better visibility.

---

## Component: `ToolResult`

**File:** `web/src/components/ToolResult.tsx`

```tsx
<ToolResult toolName={name} result={result} />
```

| Prop | Type | Description |
|------|------|-------------|
| `toolName` | `string` | Tool name — used for renderer dispatch |
| `result` | `string` | Raw result string from the backend |

The renderer is always rendered inside the details container described above, so individual renderers focus on **content**, not on chrome. Per-renderer overlays, redundant icons, and captions are avoided because the outer `result` strip already identifies the section.

---

## Result renderers

### `WebSearchResult` — `web_search`

Backend returns `list[dict]` with `{title, href, body}` per result. The renderer:

- Parses JSON; falls back to `GenericResult` if not a valid array.
- Each item renders:
  - **Title** as a clickable `<a>` link (opens in new tab, `rel="noopener noreferrer"`).
  - **Hostname pill** — extracted via `new URL(href).hostname`, `www.` stripped.
  - **Snippet** — `body` truncated to 200 chars.
- Items separated by `<hr>`.

### `ShellResult` — `shell`

Backend returns one of:
- **Foreground:** `"[Succeeded]\n\n<stdout>"` or `"[Failed — exit code N]\n\n<stdout+stderr>"`
- **Live foreground output:** optional `tool_output_delta` events append to the running tool card until `tool_end` arrives. To prevent UI lag, active live-streamed output is capped in frontend state to recent output. Once the process terminates, it is replaced with the final execution output, which is also display-truncated when very large.

Rendering:
- First line is parsed as the status token. `Succeeded` uses `--color-success`; `Failed …` uses `--color-error`. No boxed chrome, no icons.
- Remaining output in a scrollable `<pre>` (`max-h-48`, `break-words`).

> `bg` results are no longer rendered by `ShellResult`. They fall through to `GenericResult` because `bg` returns free-form management text (`PID <pid>: running`, `exited (code N)\nFinal output:\n…`, `stopped (exit code N)\nFinal output:\n…`) that does not share the foreground `[Succeeded]` / `[Failed]` header convention.

### `FileListResult` — `ls`, `glob`, `grep`

- Tries JSON array parse; falls back to splitting on newlines and trimming each line.
- Shows an entry-count metadata line (`N entries`).
- Lists entries in a scrollable `<ul>` (`max-h-64`) in monospace.

> Known limitation: `ls`'s line format (`[d] name/` / `[f] name  (123 bytes)`) and the empty-state strings from each backend tool (`(empty directory)`, `No files matching…`, `No matches for pattern…`) are rendered verbatim. Richer per-marker rendering is tracked as follow-up work.

### `FileReadResult` — `read`

- Detects the optional `[start-end/total]\n` prefix emitted by the backend when `offset`/`limit` were used and promotes it to a quiet `lines N–M of T` metadata label.
- Renders read output in a file-card surface that mirrors the edit/patch/write diff chrome: bordered scroll wrapper (`max-h-80 overflow-auto`), local `top-0` sticky `bg-(--bg-key)` header strip, file icon, and monospace body.
- Shows file contents only — no diff line markers, additions/deletions, or hunk metadata.

### `TeamMessageResult` — `team_message`

Backend returns one of:
- **Success:** `"Message sent to {recipient1}, {recipient2}."` — rendered in `--color-text-2`.
- **Error:** `"Agent(s) not found: {name}. Available: {others}"` or `"No valid recipients…"` — rendered in `--color-error`.

Plain monospace text, no icon. All colors are theme tokens — no raw Tailwind palette names.

### `TeamManageResult` — `team_manage`

Backend returns compact roster text such as `Spawned: executor#1. Dismissed: explorer#1. Errors: reviewer#1: not live.`. The renderer groups each `Label: value` segment into rows and colors error groups with `--color-error`.

### `GenericResult` — everything else

- If `result` parses as a JSON **object**, pretty-prints with `JSON.stringify(parsed, null, 2)`.
- Otherwise renders as-is in a monospace `<pre>` (`max-h-[calc(10*1.55em)]`, `break-words`). Very large displayed text is clipped by `truncateForDisplay()` and keeps head/tail context with a `... display truncated ...` marker.
- Default text color is `--color-text-2` — not `--color-success`. (Previously this renderer defaulted to green, which made every unrelated result — `write`, `edit`, `date`, `skill`, … — look "successful" even when the tool had no notion of success/failure.)

---

## Copy buttons

Both the **arguments** section and the **result** section have independent copy-to-clipboard buttons (`aria-label="Copy arguments"` / `aria-label="Copy result"`). Each uses its own boolean state (`copiedArgs` / `copiedResult`) and flips to a green check for 1.5 s after a successful copy.

The args copy button is rendered only when an args section is visible. It copies `formattedArgs` — the extracted, human-readable value — not the raw JSON string. For example, copying a `shell` tool call copies the bare command (`date`) rather than the full input object (`{"command":"date","description":"..."}`). For arguments containing stringified JSON, the copy button copies the pretty-printed, parsed JSON representation rather than the escaped string. When `formattedArgs` is null, the args section and its copy button are hidden.

---

## Adding a new renderer

1. Add a helper function (e.g. `function MyToolResult(...)`) in `ToolResult.tsx`. Keep it chrome-free — the outer panel is provided by `ToolCall`.
2. Add the tool name(s) to a `Set` constant at the top of the dispatcher section.
3. Add a branch in `ToolResult` before the final `GenericResult` fallback.
4. Add tests in `web/src/__tests__/components/ToolResult.test.tsx`.

## Adding a custom header

1. Add a branch in `getToolDisplay()` before the default fallback.
2. Return `header` as a `ReactNode` — wrap every argument value in `<Arg>` so it can be styled consistently. Keep verbs/framing text outside `<Arg>`.
3. Return `headerTitle` as the plain-string mirror (used by `title` and `aria-label`). The string should match the rendered summary text.
4. Decide on `formattedArgs`:
   - `null` → hide the args section entirely (use this when the header already carries all the useful info and no args panel would add value).
   - A short human-readable string (e.g. just the query, just the filename) → shown as-is.
   - `language: 'bash'` → also render the string as a bash code block with a `$ ` prefix.
5. **Optional — opt into a pending-state header.** Tools where the `tool_call → tool_start` gap (typically <50 ms) would otherwise flash as just the tool label can add a branch inside the `if (!args)` early return at the top of `getToolDisplay()`, mirroring `recall` and `team_message`. Without this branch the tool falls back to the humanized tool label — fine for tools whose names already read well (`Shell`, `Read`).
6. Add tests in `web/src/__tests__/components/ToolCall.test.tsx`. Use the `getHeader(fullText)` + `expectPlainArg(header, arg)` helpers so assertions survive the nested header spans.
