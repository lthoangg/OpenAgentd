---
title: Tools & Execution
description: Tool decorator, JSON schema, argument validation, and tool execution flow.
status: stable
updated: 2026-05-04
---

# Tools

**Source:** `app/agent/tools/`

Tools are plain Python functions the LLM can invoke. The `@tool` decorator wraps them with OpenAI-compatible JSON Schema metadata and Pydantic argument validation.

---

## `@tool` decorator

```python
from typing import Annotated, Literal
from pydantic import Field
from app.agent.tools import tool

@tool
async def web_search(
    query: Annotated[str, Field(description="The search query string.")],
    max_results: Annotated[int, Field(description="Max number of results to return.")] = 5,
) -> str:
    """Search DuckDuckGo for current information, news, and facts."""
    ...

@tool(name="custom_name")
def greet(name: Annotated[str, Field(description="Person's name.")]) -> str:
    """Greet a person by name."""
    return f"Hello, {name}!"
```

See `app/agent/tools/registry.py:tool` for full decorator signature and options.

### Rules for well-defined tools

1. **Type-hint every parameter** — types drive the JSON Schema sent to the LLM.
2. **`Annotated[T, Field(description="...")]`** — description tells the LLM what each arg means.
3. **Docstring = use case** — describe *when to call it*, not how it's implemented. No `Args:` / `Returns:` sections.
4. **`async def`** for I/O-bound work. Use `asyncio.to_thread()` for blocking calls.
5. **`Literal[...]`** for enumerated string parameters.
6. **Raise domain errors** — `ToolExecutionError` / `ToolArgumentError` / `SandboxPathError`, not bare `Exception`.

---

## Tool class

`Tool` objects expose:

| Attribute / method | Type | Notes |
|--------------------|------|-------|
| `.name` | `str` | Function name, or override |
| `.description` | `str` | From docstring or custom override |
| `.definition` | `dict` | OpenAI-compatible tool definition |
| `tool(...)` | callable | Calls the original function directly |
| `await tool.arun(_injected={}, **kwargs)` | coroutine | Validates args, calls function, handles sync/async |

`arun()` validates LLM-provided kwargs with Pydantic before calling the function. On `ValidationError` it raises `ToolArgumentError`.

### JSON Schema `$ref` resolution

Pydantic v2's `model_json_schema()` emits `$defs` + `$ref` when a tool parameter uses a nested Pydantic model (e.g. `list[RememberItem]` in the `remember` tool). Some providers (Gemini, Vertex AI) reject `$ref` in function declarations.

`_resolve_refs()` in `registry.py` runs automatically during `Tool._build()` — it inlines every `$ref` pointer and drops the `$defs` block. All providers receive flat, self-contained schemas with no references. This is transparent to tool authors.

### Gemini schema sanitization

The Gemini API rejects several standard JSON Schema fields in function declarations with a `400 INVALID_ARGUMENT`. `GeminiProviderBase._sanitize_schema()` (`app/agent/providers/googlegenai/googlegenai.py`) recursively strips them before the request is sent:

| Stripped field | Why |
|---|---|
| `discriminator` | Not a Gemini Schema field |
| `const` | Not supported |
| `exclusiveMinimum` / `exclusiveMaximum` | Not supported |
| `additionalProperties` | Not supported |
| `$schema`, `$id`, `$ref` | Meta-fields not accepted |
| `contentEncoding`, `contentMediaType` | Not supported |

This runs inside `_convert_tools_to_gemini()` and is transparent to tool authors. The same provider also handles `$ref` inlining via `_resolve_refs()` upstream.

### Multimodal tool results

Tools may return a `ToolResult` dataclass (from `app.agent.schemas.chat`) instead of a plain `str` to send multimodal content (images, documents) to the LLM:

```python
from app.agent.schemas.chat import ToolResult, TextBlock, ImageDataBlock

return ToolResult(parts=[
    TextBlock(text="[Image: photo.png]"),
    ImageDataBlock(data=b64_data, media_type="image/png"),
])
```

When the executor sees a `ToolResult`, it:
1. Derives `ToolMessage.content` by joining the text from `TextBlock` items (for DB persistence).
2. Sets `ToolMessage.parts` to the full parts list.
3. Providers convert `ToolMessage.parts` to their wire format (OpenAI content arrays, Gemini `InlineData`, etc.).

---

## InjectedArg — hidden parameters

Use `InjectedArg()` to pass internal data to a tool without exposing it to the LLM schema:

```python
from typing import Any
from app.agent.tools.registry import InjectedArg

@tool
async def get_session_info(
    _state: Annotated[Any, InjectedArg()] = None,
) -> str:
    """Return the current session ID."""
    if _state:
        return f"Capabilities: {_state.capabilities.input}"
    return "No state"
```

The agent loop calls `tool.arun(_injected={"_state": state}, ...)` — `_state` is injected automatically and never appears in the LLM's tool schema. Use `Any` for the type hint to avoid `get_type_hints()` resolution issues at module load; the runtime value is always `AgentState`.

**Real-world example** — the `read` tool uses injection to check vision capability:

```python
async def _read_file(
    path: Annotated[str, Field(...)],
    _state: Annotated[Any, InjectedArg()] = None,
) -> str | ToolResult:
    vision = _state.capabilities.input.vision if _state else False
    if category == "image" and not vision:
        return "File read but current model does not support vision."
    ...
```

---

## Built-in tools

### Filesystem (`builtin/filesystem/`)

The sandbox uses a **denylist** model: any path on disk is reachable except paths that resolve under one of the denied roots (`OPENAGENTD_DATA_DIR`, `OPENAGENTD_STATE_DIR`, `OPENAGENTD_CACHE_DIR`) **or match a user-defined glob pattern** from `{OPENAGENTD_CONFIG_DIR}/sandbox.yaml` (e.g. `**/.env`, `**/secrets/**` — matched against the resolved absolute path with `fnmatch.fnmatchcase`; managed via `/settings/sandbox` in the UI, see [`api/index.md`](../api/index.md#settings)). `{OPENAGENTD_STATE_DIR}/logs/` and the active session artifact directory are explicit exceptions so agents can inspect OpenAgentd logs and offloaded tool results. All relative paths resolve under `workspace_root`. Absolute paths are taken as-is, subject to the denylist. The workspace root is always exempt, even when a pattern would otherwise match. Symlinks are rejected only when their target lands inside a denied root. Tilde paths (`~/...`) are always rejected. See `app/agent/sandbox.py` and `app/agent/sandbox_config.py`. The same denylist also covers `shell` commands via a best-effort path-token scan — see [Shell § Security](#security).

| Tool | File | What it does |
|------|------|-------------|
| `read` | `read.py` | Read a file. Text files: up to 5 MB with optional `offset`/`limit` pagination; `offset` is 1-indexed and matches line numbers returned by `grep`. Images (PNG, JPG, GIF, WebP, ...): base64-encoded via `handlers.py` and returned as `ToolResult` with `ImageDataBlock` — gated by `state.capabilities.input.vision` (non-vision models get a text notice). Documents (PDF, DOCX, PPTX, XLSX, ...): converted to text via markitdown; failed PDFs fall back to raw bytes on vision models. |
| `write` | `write.py` | Write or overwrite a file (creates directories as needed) |
| `edit` | `edit.py` | Replace exact text in a file; fuzzy-matches whitespace/indentation; reports changed line metadata for inline diffs |
| `patch` | `patch.py` | Apply file patch envelopes; reports per-file/per-hunk line metadata for inline diffs |
| `ls` | `ls.py` | List directory contents with type indicators |
| `grep` | `grep.py` | Regex content search across files; returns `file:line: content`; skips dotpaths, common generated directories, and root `.gitignore` matches |
| `glob` | `glob.py` | Glob pattern search. `match='path'` (default) matches full relative path (supports `**`); `match='name'` matches filename only; skips dotpaths, common generated directories, and root `.gitignore` matches |
| `rm` | `rm.py` | Permanently delete a file or directory; `recursive=true` for non-empty directories; file removals report deleted line metadata for inline diff stats |

`read` returns raw text when called without pagination arguments. When `limit` is set, the result includes a `[start-end/total]` header and `offset=1` starts at the first line.

### Web (`builtin/web.py`)

| Tool | What it does |
|------|-------------|
| `web_search` | DuckDuckGo search — returns title, URL, snippet per result |
| `web_fetch` | Fetch a URL and return its content as Markdown, HTML, or plain text |

### Shell (`builtin/shell.py`)

| Tool | What it does |
|------|-------------|
| `shell` | Run a shell command inside the sandbox workspace. Supports `background=true` for long-running processes. |
| `bg` | Manage background processes: `list`, `status`, `output`, `wait`, `stop` |

#### `shell` parameters

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `command` | `str` | required | Shell command. Runs via the user's preferred POSIX shell (`$SHELL` → zsh → bash → sh). |
| `description` | `str` | `""` | Short description of what the command does (e.g. `'Run tests'`). Used for logging and displayed in the frontend as the tool call header. |
| `workdir` | `str \| None` | `None` | Working directory. Omit to use the session workspace root. Relative paths resolve inside the workspace; absolute paths are used as-is. |
| `timeout_seconds` | `int \| None` | `None` | Override default timeout (default 60s). Increase for long builds. |
| `background` | `bool` | `false` | Run without waiting. Returns a PID; use `bg` to manage it. |

#### Large output handling & Throttling

Foreground shell output is read incrementally while the command runs and emits live `tool_output_delta` SSE events for connected clients. To prevent UI lag and reduce Server-Sent Events (SSE) frequency, rapid shell output tokens are buffered and grouped into **100ms chunks** before being flushed.

The final tool result is still returned only when the command exits or times out. Large output is saved under `{OPENAGENTD_DATA_DIR}/sessions/{session_id}/.tool_results/shell/` and the tool returns the artifact path plus the last 200 lines inline. A `<shell_metadata>` advisory block is appended on timeout.

To keep the DOM lightweight and prevent UI lag during active live-streaming, the frontend limits the active live-streamed shell output to the **50 most recent lines** (truncating older lines). Once the process terminates, it is replaced with the full execution output (up to 300 lines).

For tool result offloading (applied across all tools), `ToolResultOffloadHook` kicks in when the result string exceeds `DEFAULT_CHAR_THRESHOLD` (default 40000 chars — see `app/agent/hooks/tool_result_offload.py`). See [Tool Result Offload](hooks.md#toolresultoffloadhook).

#### Background mode

When `background=true`:
- The process is spawned and tracked in a module-level registry keyed by PID.
- A short warmup period (up to 5s) captures initial output and detects immediate crashes.
- If the process exits during warmup, it is treated as a foreground failure.
- Otherwise, returns `[Background — PID <pid>]` with the command and initial output.
- Output is continuously drained into a 200-line ring buffer.
- Use `bg` to inspect, wait for completion, or stop it.

#### `bg` parameters

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `action` | `Literal['list','status','output','wait','stop']` | required | `list` all processes; other actions require a PID |
| `pid` | `int \| None` | `None` | PID (required except for `list`) |
| `last_n_lines` | `int \| None` | `None` | For `output` and `wait`: return only the last N lines (default all, max 200) |

#### Non-interactive execution

`stdin` is always set to `/dev/null`. Commands that prompt for input will receive immediate EOF and exit with a non-zero code instead of hanging until the timeout. Always use non-interactive flags:

| Tool | Flag |
|------|------|
| `npm create` / `npx` | `--yes` or `-- --template <t>` to skip framework picker |
| `npm init` | `-y` |
| `apt-get` | `-y` |
| `pip install` | `-q` (already non-interactive) |

#### Process cleanup

All subprocesses are started with `start_new_session=True`, which places them in a new process group. On timeout or `stop`, the tool sends signals to the **entire process group** via `os.killpg()` — not just the top-level shell. This ensures child processes spawned by the command (e.g. `npm run dev` spawning `node`) are also cleaned up. Falls back to direct `proc.send_signal()` if the group kill fails.

#### Security

Shell commands are gated by the **permission system** (`app/agent/permission.py`) before execution. By default `AutoAllowPermissionService` is active — it fires `permission_asked` SSE events and auto-approves. A blocking `PermissionService` with user-defined `Rule`/`Ruleset` (wildcard, last-match-wins) can be wired in when a frontend approval UI is ready. The old denylist (`sudo`, `rm -rf`, etc.) has been removed in favour of this rule-based approach.

Path containment for file tools is enforced by `SandboxConfig.validate_path` — see [Filesystem](#filesystem-builtinfilesystem). The `shell` tool also performs a best-effort command path scan via `SandboxConfig.check_command`. The default shell timeout is 60s; large output spills to the session-scoped `.openagentd/sessions/<session_id>/.tool_results/shell/` directory.

### Date (`builtin/date.py`)

| Tool | What it does |
|------|-------------|
| `date` | Return today's date and local time |

### Multimodalities (`multimodalities/`)

Generative media tools. Each kind is gated by a section in `{OPENAGENTD_CONFIG_DIR}/multimodal.yaml`; if the section is missing or the referenced env var is unset, the tool returns a "not configured" error at call time (the agent sees the failure but the server still starts). Voice input transcription lives in `speech.yaml`, not `multimodal.yaml`; it is a UI/API feature, not an LLM tool.

| Tool | File | What it does |
|------|------|-------------|
| `generate_image` | `image.py` | Create **or** edit an image in the session workspace. Returns markdown `![prompt](filename.ext)` so the image embeds inline — the frontend rewrites the bare filename to `/api/team/{sid}/media/{filename}`. Saved extension matches the resolved `output_format` (defaults to `png`). |
| `generate_video` | `video.py` | Generate a video clip in the session workspace. Five input modes (text-to-video, image-to-video, first+last-frame interpolation, reference images, video extension). Returns markdown `![prompt](filename.mp4)` plus a `extend_video="<uri>"` note the LLM can use for a follow-up extension call; the frontend's `MarkdownVideo` detects the `.mp4`/`.webm`/`.mov`/`.m4v` extension and renders `<video controls>` via the same `/api/team/{sid}/media/` proxy. |

#### `generate_image` parameters

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `prompt` | `str` | required | Describes the image to generate, or (when `images` is given) the transformation to apply. |
| `filename` | `str \| None` | `None` | Output slug inside the workspace. Sanitised server-side: any trailing extension is stripped, non-`[A-Za-z0-9_-]` runs are collapsed to `-`, then the resolved format extension (`.png` / `.jpeg` / `.webp`) is appended. When omitted, a random `image-<hex>.<ext>` is used. |
| `images` | `list[str] \| None` | `None` | Workspace-relative paths of input images (1–16 for `openai`, 1–14 for `googlegenai`; `codex` has no documented cap). When non-empty, switches to image-edit mode. Each path is resolved via the sandbox; missing files, symlink escapes, and files over 5 MB are rejected before any HTTP call. |
| `size` | `Literal["auto", "1024x1024", "1536x1024", "1024x1536"] \| None` | `None` | Per-call override. Falls back to `image.size` in `multimodal.yaml`. |
| `output_format` | `Literal["png", "jpeg", "webp"] \| None` | `None` | Per-call override for output file format. Falls back to `image.output_format` in `multimodal.yaml`, else `png`. Drives both the API parameter and the saved-file extension. |
| `aspect_ratio` | `Literal["1:1", "3:4", "4:3", "9:16", "16:9"] \| None` | `None` | Per-call override. Falls back to `image.aspect_ratio` in `multimodal.yaml`. |
| `image_size` | `Literal["0.5K", "1K", "2K", "4K"] \| None` | `None` | Per-call override. Falls back to `image.image_size` in `multimodal.yaml`. |

Mode is implicit: no `images` (or `images=[]`) → text-to-image; `images=[...]` → image edit/compose. Same `image.model` drives both. Per-call overrides always win over YAML defaults; invalid enum values are rejected with a framed `Error: ...` string before any HTTP call. Each backend silently ignores params it doesn't understand (e.g. `aspect_ratio` is a no-op on `openai`; `size` is a no-op on `googlegenai`) — one tool schema works across providers.

#### `generate_video` parameters

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `prompt` | `str` | required | Text description of the video. Can include camera direction, action, style, ambiance, and dialogue (wrap dialogue in quotes). |
| `filename` | `str \| None` | `None` | Output slug inside the workspace. Any trailing extension is stripped; non-`[A-Za-z0-9_-]` runs are collapsed to `-`; then `.mp4` is appended. When omitted, a random `video-<hex>.mp4` is used. |
| `first_frame` | `str \| None` | `None` | Workspace-relative path of the **starting frame**. Switches to image-to-video mode. |
| `last_frame` | `str \| None` | `None` | Workspace-relative path of the **ending frame**. Requires `first_frame`. Triggers first→last interpolation. Mutually exclusive with `reference_images`. |
| `reference_images` | `list[str] \| None` | `None` | Workspace-relative paths (up to 3) of subject/style references. Forwarded as `referenceImages[].{image, referenceType: "asset"}`. Mutually exclusive with `last_frame`. Veo 3.1 / Fast only. |
| `extend_video` | `str \| None` | `None` | Files API URI of a **previously Veo-generated** video (e.g. `https://generativelanguage.googleapis.com/v1beta/files/…`) to extend by 8 s. Mutually exclusive with all other image/video inputs. Forced to 16:9 / 720p / 8 s. URI is returned in the tool result after each successful generation for reuse. Files API URIs expire after 2 days. |
| `aspect_ratio` | `Literal["16:9", "9:16"] \| None` | `None` | Per-call override. Falls back to `video.aspect_ratio` in `multimodal.yaml`. Must be `"16:9"` (or omitted) for extension. |
| `resolution` | `Literal["720p", "1080p", "4k"] \| None` | `None` | Per-call override. `1080p`/`4k` only support 8s duration. Falls back to `video.resolution`. Must be `"720p"` (or omitted) for extension. |
| `duration_seconds` | `Literal["4", "6", "8"] \| None` | `None` | Per-call override. Must be `"8"` for extension, `1080p`, `4k`, or reference images. Falls back to `video.duration_seconds`. |

Mode is implicit: no inputs → text-to-video; `first_frame` → image-to-video; `first_frame` + `last_frame` → interpolation; `reference_images` → subject/style references; `extend_video` → video extension. Mutually exclusive combinations, invalid enum values, and sandbox path errors all return a framed `Error: ...` string **before any HTTP call**.

Every successful call returns `![prompt](file.mp4)\n\nTo extend this video, pass \`extend_video="<uri>"\`.` — the LLM can pass that URI directly on a follow-up call.

Because Veo is a long-running operation, the tool blocks on an async poll loop (interval `10s`, hard deadline `10 min`) between `predictLongRunning` and the final mp4 download. The agent turn stays in-flight for the whole wait — per the Veo docs, latency ranges from `11s` to `6 min` on preview tier.

#### `multimodal.yaml`

```yaml
# ── IMAGE ────────────────────────────────────────────────────────────────────
# Option A — OpenAI (DALL·E / GPT image family)
image:
  model: openai:gpt-image-2   # "<provider>:<model>"
  size: 1024x1024             # default; tool `size` param overrides per call
  output_format: png          # default; tool `output_format` param overrides per call
  quality: auto               # YAML-only (not exposed as a tool param)

# Option B — Google GenAI (Gemini 3 Image)
# image:
#   model: googlegenai:gemini-3.1-flash-image-preview
#   aspect_ratio: "1:1"       # default; tool `aspect_ratio` param overrides per call
#   image_size: 1K            # default; tool `image_size` param overrides per call

# Option C — OpenAI Codex (ChatGPT Plus/Pro subscription, OAuth — no API key)
# image:
#   model: codex:gpt-5.4      # any codex chat model; image-gen rides the Responses API
#   size: 1024x1024
#   output_format: png
#   quality: auto

# ── VIDEO ────────────────────────────────────────────────────────────────────
# Google GenAI (Veo 3.1) — only registered video backend. Reads GOOGLE_API_KEY.
video:
  model: googlegenai:veo-3.1-generate-preview   # or veo-3.1-fast-generate-preview / veo-3.1-lite-generate-preview
  aspect_ratio: "16:9"       # default; tool param overrides per call
  resolution: "720p"         # default; 1080p / 4k only with 8s duration
  duration_seconds: "8"      # default; "4" / "6" / "8"
  # YAML-only knobs (not exposed as tool params):
  # person_generation: "allow_adult"     # region-gated; leave unset for provider default
  # negative_prompt: "low quality, blurry"
  # seed: "42"

```

The `model` field mirrors the `provider:name` format used by agent `.md` files. The legacy shape with separate `provider:` + `model:` keys is rejected by the loader — update any old config.

The file is loaded once and reloaded on mtime change — no server restart needed when editing.

Voice input uses client-side speech recognition and has no backend tool/config file — see [`web/voice-input.md`](../web/voice-input.md).

**Registered backends:**

- **`openai`** (image only) — reads `OPENAI_API_KEY` from the environment (via `settings.OPENAI_API_KEY` with `os.getenv` fallback). Understands `size` / `output_format` / `quality` (passthrough keys); ignores Gemini-shaped keys. Two entry points, both accept an optional `overrides: dict[str, str]` merged over the YAML extras before the request — caller wins:
  - `generate(cfg, prompt, overrides)` → JSON POST to `/v1/images/generations`.
  - `edit(cfg, prompt, images, overrides)` → multipart POST to `/v1/images/edits` with repeated `image[]` parts (1–16 images, OpenAI's cap).
- **`googlegenai`** (image) — reads `GOOGLE_API_KEY` (via `settings.GOOGLE_API_KEY` with `os.getenv` fallback). Understands `aspect_ratio` / `image_size` (forwarded as `generationConfig.imageConfig.{aspectRatio,imageSize}`); ignores OpenAI-shaped keys. Both modes POST to the same `:generateContent` endpoint; edit mode differs by appending `inline_data` parts alongside the text part (1–14 references, Gemini 3.1 Flash Image Preview cap). Output is always PNG.
- **`codex`** (image only) — uses the same OAuth token as the [Codex chat provider](../configuration.md#openai-codex-provider) (`{OPENAGENTD_CACHE_DIR}/codex_oauth.json`, set via `openagentd auth codex`); ignores `OPENAI_API_KEY`. There is no dedicated images endpoint — both `generate` and `edit` POST to `https://chatgpt.com/backend-api/codex/responses` with an `image_generation` tool entry, `stream: true`, and parse the SSE for `response.output_item.done` carrying an `image_generation_call` item with the final base64. Reference images are inlined into `input[0].content` as `input_image` data URLs wrapped in `<image name=imageN>` tags (mirroring codex-imagen / 9router). Understands `size` / `quality` / `background` / `output_format`; ignores Gemini-shaped keys. Headers spoof codex-cli identity (`originator: codex_cli_rs`, `user-agent: codex-imagen/...`) — the upstream rejects unknown originators. Requires an active ChatGPT Plus / Pro / Business / Edu / Enterprise subscription.
- **`googlegenai`** (video, `backends/googlegenai_video.py`) — shares the `GOOGLE_API_KEY` lookup with the image backend but targets the Veo `predictLongRunning` endpoint. Single entry point `generate(cfg, prompt, *, image, last_frame, reference_images, extend_video, overrides)` — image inputs are `(filename, raw_bytes)` tuples; `extend_video` is a Files API URI string. Returns `(mp4_bytes, video_uri)` on success. Wire format for image fields is `{"bytesBase64Encoded": "…", "mimeType": "…"}` (flat, not `inlineData` — confirmed empirically, the live API rejects `inlineData`). Extension uses `{"video": {"uri": "<Files API URI>"}}` — raw bytes are not accepted for the `video` field. Understands `aspect_ratio` / `resolution` / `duration_seconds` / `person_generation` / `negative_prompt` / `seed`; silently ignores image-shaped keys. Flow: POST `predictLongRunning` → poll every 10s until `done=true` → extract `generatedSamples[0].video.uri` → download mp4. Hard cap 10 min.

Provider dispatch lives in `_IMAGE_BACKENDS` (`image.py`) and `_VIDEO_BACKENDS` (`video.py`) — each image entry is an `_ImageBackend` dataclass holding both `generate` and `edit` callables; video backends are plain `generate` coroutines (Veo has no symmetric "edit" operation today). Register a new provider by adding `backends/<name>.py` exposing the right function(s) and an entry in the relevant dict.

### MCP servers (`app/agent/mcp/`)

External tools loaded over the [Model Context Protocol](https://modelcontextprotocol.io). Each configured MCP server is launched at startup, its tool list is merged into the agent registry, and tools become callable as `mcp_<server>_<tool>`.

**Config:** `{CONFIG_DIR}/mcp.json` — managed via `/api/mcp/servers` (CRUD + restart) and the **Settings → MCP** UI tab. Two transport shapes:

```json
{
  "servers": {
    "filesystem": {
      "transport": "stdio",
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"],
      "env": {},
      "enabled": true
    },
    "remote": {
      "transport": "http",
      "url": "https://mcp.example.com/v1",
      "headers": {"Authorization": "Bearer ${REMOTE_MCP_TOKEN}"},
      "enabled": true
    },
    "notion": {
      "transport": "http",
      "url": "https://mcp.notion.com/mcp",
      "headers": {},
      "oauth": {},
      "enabled": true
    },
    "slack": {
      "transport": "http",
      "url": "https://mcp.slack.com/mcp",
      "headers": {},
      "oauth": {
        "client_id": "${SLACK_MCP_CLIENT_ID}",
        "client_secret": "${SLACK_MCP_CLIENT_SECRET}"
      },
      "enabled": true
    }
  }
}
```

#### Stdio PATH Resolution & Desktop App Robustness

When running the desktop app in production (e.g., launched from the macOS Dock or Finder), the application inherits a minimal system `PATH` that lacks user-installed tools like Node, npm, `npx`, or `uvx`.

To ensure stdio MCP servers run seamlessly:
- **User Shell PATH Resolution:** The manager queries the user's login shell (e.g., `zsh -l` or `bash -l`) to retrieve their full terminal `PATH` and merges it into the subprocess environment.
- **Surgical Command Resolution:** It uses `shutil.which` with the resolved path to locate the absolute path of the command (e.g., `/usr/local/bin/npx`).
- **Minimal Environment Inheritance:** Stdio servers receive the detected `PATH` plus explicit per-server `env` entries only; the full OpenAgentd process environment is not forwarded to avoid leaking provider keys or desktop credentials.
- **Dynamic Re-detection:** If a command is not found, the manager clears its cached path and re-runs the shell detection once. This allows desktop users to install a missing tool (like Node/npx) in their terminal and simply click **Restart** on the MCP server in the settings UI without restarting the entire desktop app.
- **Thundering Herd Prevention:** Concurrent startup requests for the user's shell path are serialized using an `asyncio.Lock` to avoid spawning multiple shell processes.

HTTP `headers` may reference secrets from the process env or `{CONFIG_DIR}/.env` via `$VAR` / `${VAR}`. API responses mask header values. OAuth app credentials may be configured with `oauth.client_id` / `oauth.client_secret`; Settings stores pasted values as `<SERVER>_MCP_CLIENT_ID` / `<SERVER>_MCP_CLIENT_SECRET` in `{CONFIG_DIR}/.env` and writes `${...}` refs to `mcp.json`. OAuth tokens are stored under `{OPENAGENTD_CACHE_DIR}/mcp-oauth/`; missing tokens show `state="auth_required"` until the user clicks **Connect OAuth** in Settings.

**Lifecycle:** `MCPManager.start()` runs in `lifespan()` before `team_manager.start()`. Because `start()` only *spawns* runner tasks, `lifespan` then awaits `mcp_manager.wait_until_ready()` (10s default) so the team loader sees populated tool lists. Servers still pending after the timeout fall through to graceful empty — the agent loads with no tools from that server, matching the not-ready contract. Each server runs in a long-lived `asyncio.Task` holding the `ClientSession` open via `AsyncExitStack`; a failed server is logged with `state="error"` and never blocks others.

**Agent opt-in:** MCP tools are NOT auto-injected. Use the `mcp:` frontmatter field to grant the agent every tool from a configured server:

```yaml
mcp:
  - filesystem
  - context7
```

Each tool is exposed to the LLM as `mcp_<server>_<tool>` (the convention `MCPTool.__init__` enforces). Listing individual tool names under `tools:` still works for surgical access, but `mcp:` is the simpler default — and the API's per-agent `mcp_servers` field (see [`api/index.md`](../api/index.md#agent-config-management)) lets the UI group tools by server.

**Permission gating:** the wildcard `mcp_*` is recognised by `ruleset_from_config` (see `app/agent/permission.py`), so a single rule can allow / deny / ask for every MCP tool at once.

**Sandboxed UI artifacts / MCP Apps:** tool-produced HTML UI resources can render as sandboxed chat artifacts. The first supported producer is MCP Apps: tools that declare `_meta.ui.resourceUri` and return a `ui://` resource with MIME `text/html;profile=mcp-app`. Excalidraw MCP diagrams appear as sibling artifacts after the completed tool call and can request fullscreen; the host also exposes a fullscreen button and uses full-viewport/safe-area-aware layout. When multiple completed tool results reference the same `resourceUri`, OpenAgentd renders only the newest artifact for that resource so iterative views replace stale copies; different resource URIs still render independently. OpenAgentd stores the app payload in the tool message's `extra.mcp_app` so reloads can rehydrate it, while the LLM-visible tool result remains plain text. The renderer keeps the iframe sandboxed (`allow-scripts allow-same-origin allow-forms`), injects a small in-memory `localStorage`/`sessionStorage` shim for apps that probe browser storage, and honors resource CSP domain metadata; executable app HTML currently requires inline scripts and eval-capable bundles. App-requested server `tools/call` requests must be bound to the persisted `session_id` + `tool_call_id`, must match the artifact's `mcp_app.server`, and are authorized against that server's current advertised tool list at call time. OpenAgentd still does not expose frontend tool listing or cross-server app-to-server calls.

**Source:** `app/agent/mcp/{config,manager,tools}.py`. Routes: `app/api/routes/mcp.py`.

### Skill loader (`builtin/skill.py`)

| Tool | What it does |
|------|-------------|
| `skill` | Load a skill's full instructions from the highest-precedence matching skill root |
| `discover_skills` | List available skills with descriptions (internal — not exposed to LLM) |

Skills use the directory format `skills/{name}/SKILL.md` with YAML frontmatter (`name`, `description`) and a Markdown body. Discovery walks roots in precedence order: `{cwd}/.openagentd/skills`, `{cwd}/.opencode/skills`, `{SKILLS_DIR}`, `~/.config/opencode/skills`, then bundled read-only OpenAgentd skills; the first matching skill name wins.

The loader expands four placeholders in both the description (used in the agent's system prompt) and the body returned to the LLM, so installer skills can reference concrete absolute paths without hard-coding them: `{OPENAGENTD_CONFIG_DIR}`, `{AGENTS_DIR}`, `{SKILLS_DIR}`, `{SKILL_DIR}` (the calling skill's own directory). Other `{...}` content is left untouched.

### Todo list (`builtin/todo.py`)

| Tool | What it does |
|------|-------------|
| `todo_manage` | Create, update, delete, or read tasks — accepts a list of actions executed in order |

`todo_write` and `todo_read` have been replaced by the single `todo_manage` tool. It accepts `actions: list[Action]` so multiple operations can be batched in one call.

#### Actions (discriminated union on `action` field)

| Action | Audience | Required fields | Optional fields | Notes |
|--------|----------|----------------|-----------------|-------|
| `create` | Lead | `content`, `status`, `priority` | `dependencies`, `assigned_to` | Returns auto-assigned `task_id` (`task_1`, `task_2`, …) |
| `update` | Lead | `task_id` | `content`, `status`, `priority`, `dependencies`, `assigned_to` | Mutates matching item; error string if not found |
| `delete` | Lead | `task_id` | — | Removes item permanently; error string if not found |
| `claim` | Member | `task_id` | — | Claims an assigned, unblocked task for the calling agent and moves it to `in_progress` |
| `update` | Member | `task_id` | `content`, `status` | Mutates a task assigned to or claimed by the calling member |
| `read` | Lead + member | — | — | No-op on the store; result always returned at end |

#### Storage format

```json
{
  "counter": 3,
  "items": [
    {"task_id": "task_1", "content": "…", "status": "completed", "priority": "high", "dependencies": [], "assigned_to": "member#1", "claimed_by": "member#1"},
    {"task_id": "task_2", "content": "…", "status": "pending", "priority": "medium", "dependencies": ["task_1"], "assigned_to": "member#2", "claimed_by": null}
  ]
}
```

Stored in `{OPENAGENTD_DATA_DIR}/sessions/{session_id}/.todos.json`, not in the workspace or coding repo. The store is session-scoped, so coding-mode sessions in the same project do not share todos. `counter` is monotonically increasing and cached in `state.metadata["_todos"]` within a turn.

Each item has these fields:

| Field | Values |
|-------|--------|
| `task_id` | Auto-assigned slug: `task_1`, `task_2`, … |
| `content` | Brief task description |
| `status` | `pending` \| `in_progress` \| `completed` \| `cancelled` |
| `priority` | `high` \| `medium` \| `low` |
| `dependencies` | List of prerequisite task IDs that must be `completed` before claim/start |
| `assigned_to` | Optional concrete agent handle assigned to the task, e.g. `executor#1` |
| `claimed_by` | Optional agent handle that claimed the task |

For team work, spawn members before assigning their todos and use the returned concrete handle in `assigned_to` (for example, `executor#1`, not `executor` or `executor/explorer`). For dependent team work, create downstream tasks with `dependencies=["task_1"]` and keep them `pending`. Members call `claim` before starting; claims are rejected while dependencies are incomplete, assigned to another handle, or already claimed, so blocked agents do not start early. If a member is stopped or fails, unfinished todos assigned to or claimed by it are unassigned; claimed `in_progress` todos are also reset to `pending`. If a member owns an unfinished todo but ends a turn without `<sleep>` or `team_message`, the runtime injects a bounded hidden reminder to continue or report via `team_message`.

**Frontend:** `tool_call`, `tool_start`, `tool_output_delta`, and `tool_end` SSE events for `todo_manage` are suppressed in the UI — no tool block is rendered in the chat. `tool_end` still invalidates `queryKeys.todos(sessionId)`, refetching `GET /api/team/sessions/{id}/todos`. History reload (`parseTeamBlocks`) also filters out `todo_manage` tool calls so they never appear on page refresh. The **Todos** popover in the chat header (`Ctrl+T`) displays the result — see [`documents/docs/web/todos.md`](../../docs/web/todos.md).

### Scheduler (`builtin/schedule.py`)

| Tool | What it does |
|------|-------------|
| `schedule_task` | The lead's **personal reminder queue** — schedules prompts that fire back to the same lead later. Create, list, pause, resume, delete, trigger. |

Semantically a future-self note: every reminder the lead schedules fires back to *itself* (same mode, same workspace). There is no cross-team or cross-workspace surface — the tool only ever sees and acts on reminders bound to the calling lead's routing context.

When a reminder fires, the dispatched message is prefixed with the task name:
```
[Scheduled Task: daily-report]
Generate the daily report and send it to Slack.
```
This signals to the agent (and is visible in session history) that the turn is automated and which reminder triggered it.

#### Actions

| Action | Required args | Notes |
|--------|--------------|-------|
| `create` | `name`, `schedule_type`, `prompt` + schedule fields | Validates via `ScheduledTaskCreate`; starts timer immediately |
| `list` | — | Returns the **caller's own** reminders (scope-filtered, see below) |
| `pause` | `task_id` (UUID) | Disables, cancels timer |
| `resume` | `task_id` (UUID) | Re-enables, recomputes next fire |
| `delete` | `task_id` (UUID) | Cancels timer, removes from DB |
| `trigger` | `task_id` (UUID) | Fires immediately without affecting schedule |

#### Routing target — auto-injected & enforced

`mode` (`"normal"` | `"coding"`) and `workspace` are **not** part of the
LLM-visible tool schema. The tool executor injects them from the calling
agent's runtime context (`state.metadata["team_mode"]` /
`["team_workspace"]`, populated by `TeamMemberBase` from the live team)
so a lead in a coding workspace always schedules into that same team —
the LLM cannot specify or lie about the target. Fires route to:

* `mode="normal"` → `team_manager.get_or_start_team()` (default lead)
* `mode="coding"` → `team_manager.get_or_start_coding_team(workspace)`

The same `(_mode, _workspace)` is also the **scope filter** for every
non-create action. `list` returns only in-scope reminders;
`pause` / `resume` / `delete` / `trigger` reject out-of-scope task IDs
with the same `"no task with id …"` surface as truly missing rows — so
cross-scope existence cannot be probed and no mutation reaches the
scheduler. See `_in_scope` in `app/agent/tools/builtin/schedule.py`.

When `session_id` is an explicit UUID that already exists, `scheduler.create` / `apply_update` reject mismatched `(mode, workspace)` pairs with `InvalidTaskTargetError` (HTTP 422).

Tasks can also be updated after creation via `PUT /api/scheduler/tasks/{id}` (REST) or through the **Edit** button in the web UI `SchedulerPanel`. Updatable fields: `mode`, `workspace`, `schedule_type`, schedule value fields, `timezone`, `prompt`, `session_id`, `enabled`. See [`api/index.md`](../../docs/api/index.md#scheduler-endpoints).

#### Schedule types

| `schedule_type` | Required field | Example |
|----------------|---------------|---------|
| `every` | `every_seconds: int > 0` | `every_seconds=3600` → hourly |
| `cron` | `cron_expression: str` (5-field) | `"0 9 * * 1-5"` + `timezone="Asia/Ho_Chi_Minh"` |
| `at` | `at_datetime: str` (ISO-8601) | `"2026-05-01T09:00:00+00:00"` — one-shot |

#### Session continuity (`session_id`)

| Value | Behaviour |
|-------|-----------|
| `null` (default) | New session minted on every firing (uuid7) |
| `"auto"` | Persistent session — resolved to `uuid5(NAMESPACE_URL, "scheduler:{name}")`, deterministic so the same task always reuses the same `ChatSession` row |
| UUID string | Continue a specific existing session |

`skill` is **always injected** into every agent — do not list it in `tools:`.

`todo_manage`, `schedule_task`, and `note` are **always injected into the lead agent** — do not list them in `tools:`. In team mode, `todo_manage` is also injected into members so they can claim assigned tasks.

In team mode, `team_message` and `todo_manage` are injected into every agent; `team_manage` is injected into the lead only — see [`teams.md`](teams.md#team-communication-tools).

---

## Registering tools

Three paths — no core code changes needed:

### 1. Agent `.md` frontmatter (most common)

```yaml
tools:
  - web_search
  - read
  - shell
```

The loader maps names to built-in `Tool` objects.

### 2. `load_team_from_dir(extra_tools=...)`

Pass custom tools at load time:

```python
from app.agent.loader import load_team_from_dir

custom = Tool(my_function, name="my_tool")
team = load_team_from_dir(agents_dir, extra_tools={"my_tool": custom})
```

### 3. `agent.run(injected_tools=[...])`

Inject per-run only — never mutates `agent._tools`:

```python
await agent.run(messages, injected_tools=[my_tool])
```

Team coordination tools use this path — `AgentTeam.get_injected_tools(member_name)` returns the right set of lead/member tools per turn.

---

## Tool execution flow

```
agent_loop → _run_tool(state, tc, chain)
│
├─ semaphore (max_concurrent_tools=10)
│
└─ tool hook chain:
    Hook0.wrap_tool_call → Hook1.wrap_tool_call → … → execute_fn
    │
    ├─ parse args: json.loads(tc.function.arguments)
    ├─ lookup: run_tools[tc.function.name]
    ├─ tool.arun(_injected={"_state": state}, **args)
    │    ├─ Pydantic validation of args
    │    └─ call underlying function (sync or async)
    └─ return str result (dict/list → json.dumps)
```

Errors during execution return `"Error: <sanitized_message>"` as the tool result — the agent sees it and can retry or report the issue. Sandbox paths are stripped from error messages.

---

## Boundaries

Tools may import from:
- `app.agent.sandbox` — path validation, `get_sandbox()`
- `app.agent.errors` — domain exceptions

Tools must **not** import from:
- `app.api` — no route coupling
- `app.agent.hooks` — no hook awareness
- `app.services` — no direct DB access (use injected state or agent context)
- `app.agent.providers` — no LLM calls from tools (use `AgentState` if needed)
