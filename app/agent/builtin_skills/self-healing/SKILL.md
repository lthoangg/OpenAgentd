---
name: self-healing
description: >-
  Update or upgrade the agent's own configuration on request — swap the model,
  tune thinking/temperature, add tools or MCP servers, change the
  image-generation provider/model, or install a new skill. Use when the user
  says things like "upgrade yourself", "switch your model to X", "use Gemini
  for images", "make yourself faster/smarter".
---

# Self-Healing Skill

This skill lets the agent modify its own on-disk configuration in
response to a user request. All changes are surgical edits to files
under `{OPENAGENTD_CONFIG_DIR}/`. No code changes, no restarts. Agent
`.md` edits take effect on the **next turn** of the affected agent;
`multimodal.yaml` is read on every image/video generation call.

## Pick the right team first — modes matter

OpenAgentd runs two team **modes**, and each has its own agent files. Editing
the wrong team's lead is the most common mistake here — resolve this before
touching any file.

| Mode | When active | Agent files |
|------|-------------|-------------|
| `normal` (cockpit / team chat) | default; no workspace attached | `{AGENTS_DIR}/*.md` — lead + `executor`, `explorer` |
| `coding` (workspace) | a coding workspace is attached (fs + shell scoped to it) | `{AGENTS_DIR}/coding/*.md` — lead + `coder`, `explorer` |

Both leads are named `openagentd` with `role: lead`; they differ only by
directory. **Match the team you are currently running as:** if this turn is a
coding-workspace turn, edit `{AGENTS_DIR}/coding/openagentd.md`; otherwise edit
`{AGENTS_DIR}/openagentd.md`. When unsure which mode you are in, say so and ask
rather than guessing — a model swap applied to the wrong team is silently
ineffective. MCP servers and `multimodal.yaml` are **global** (shared by both
modes); only the agent-file *wiring* is per-mode.

The two leads also ship **different built-in tool profiles**: the `normal` lead
includes `generate_image` / `generate_video` by default; the `coding` lead does
**not** (it is shell/filesystem-focused). So "let yourself generate images"
while in coding mode is a real additive change — add `generate_image` to that
agent's `tools:`; it is not already there.

## Scope — what this skill can change

| Target | File | Typical request |
|--------|------|-----------------|
| Agent model / params | `{AGENTS_DIR}/{name}.md` (normal) or `{AGENTS_DIR}/coding/{name}.md` (coding) frontmatter — see "Pick the right team first" | "switch to gpt-5", "use Claude", "lower temperature", "turn on high thinking" |
| Agent tools | same file, `tools:` list | Additive local overrides on top of any built-in first-party profile tools. "give yourself shell access", "let yourself browse the web" |
| Agent skill metadata | same file, `skills:` list | Rare additive explicit metadata/drift hooks. Installing a new skill normally does **not** require editing agent files; the `skill` tool discovers skills from project/global roots. |
| Agent MCP tools | same file, `mcp:` list (bulk) or `tools:` list (selective) | Additive local overrides on top of any built-in first-party profile MCP servers/tools. "let yourself use the filesystem MCP", "remove the github MCP from yourself" — see "MCP tools on agents" below |
| Image / video generation | `{OPENAGENTD_CONFIG_DIR}/multimodal.yaml` | "generate images with Gemini instead", "switch to Veo for video", "make images higher quality", "use 1080p video" |
| New skills | `{OPENAGENTD_CONFIG_DIR}/skills/{name}/SKILL.md` | "install a skill for reviewing pull requests" — **delegate to `skill-installer`** |

Out of scope (refuse and explain): editing `.env` / secrets, changing provider
source code, adding built-in tools, touching files outside
`{OPENAGENTD_CONFIG_DIR}/`. Note that the sandbox workspace is **not** the
config directory — pass the absolute config path to `read` / `write` / `edit`
rather than relative names.

## Agent capability changes

Use this self-healing workflow for root/blueprint config changes:

- Adding persistent first-party extras to `tools:` / `mcp:` in an agent `.md` file.
- Editing `skills:` only when the user explicitly wants agent-file metadata changed; do not add a skill there as part of normal skill installation.
- Removing user-added extras from an agent `.md` file.
- Explaining that built-in first-party capabilities cannot be removed through `.md` overrides; `.md` files are additive only.
- Edits to the **lead's own** `.md`.
- Multi-field changes (e.g. model + temperature + tools in one diff).
- Anything outside `tools` / `skills` / `mcp` — `model`, `temperature`,
  `thinking_level`, system prompt body. (Summarisation
  tuning is not editable per-agent — it lives in code; refuse and refer
  the user to `app/agent/hooks/summarization.py`.)
- Editing `multimodal.yaml`.
- Creating a new agent file.

For those, follow the read → diff → confirm → edit recipe.

## Workflow — any change

1. **Identify the target file.** Ask the user "which agent?" only if ambiguous;
   otherwise pick the agent that matches the conversation (most often the lead).
2. **Read the current file** so you know the exact existing frontmatter / YAML.
   If the file doesn't exist yet, note that — you will `write` it from scratch
   (step 6) rather than `edit` it.
3. **Compute the minimal diff** — change only the fields the user asked about.
   Never reformat unrelated lines, never drop existing fields.
4. **Show the diff to the user** as a fenced ```diff block (old → new) with a
   one-line summary of what it does.
5. **Wait for confirmation** — do NOT write until the user says "go" /
   "yes" / "apply". If the user's original message was already explicit
   ("update yourself to use gpt-5 now"), treat that as pre-approval and skip
   the wait — but still show the diff in the same turn as the write.
6. **Apply with `edit`** (preferred — preserves the rest of the file verbatim).
   Use `write` only when creating a new file.
7. **Report what changed and which file.** Tell the user when it
   takes effect (see table below). Do **not** mention restarts —
   there are none.

## Recipes

### Find your own agent file

When the user says "upgrade *yourself*", you (the lead) need your own
`.md` path. There is one lead **per mode** (`role: lead`), so search both roots
and pick the one for the team you are currently running as (see "Pick the right
team first"):

```bash
# normal/cockpit lead  → top level;  coding lead → coding/ subdir
grep -l 'role: lead' {AGENTS_DIR}/*.md {AGENTS_DIR}/coding/*.md
```

For member agents, match by `name:` within the active mode's directory — normal
has `executor` / `explorer`, coding has `coder` / `explorer` (note `explorer`
exists in both, so scope the glob to the right dir). Don't hard-code filenames;
agent files are user-renamable.

### Setting up `multimodal.yaml` from scratch

When `generate_image` or `generate_video` returns a "not configured" error
(i.e. the `image:` / `video:` section is missing from `multimodal.yaml`),
or when the user explicitly asks to set up image / video generation.

**Handle this inline — do not delegate to a member agent.** The member has no
access to this skill and will fall back to its own reasoning, producing
inconsistent behaviour.

1. **Pick a provider** — use whatever the user specifies; if unspecified, default
   to `openai:gpt-image-2` for images or `googlegenai:veo-3.1-generate-preview`
   for video. Do not ask — just decide.

2. **Write immediately** — `write` if the file is new, `edit` if the section is
   missing. Do **not** check env vars or credentials before writing; do **not**
   warn about missing keys; do **not** ask the user to verify their `.env`.
   Credential handling is the tool's responsibility.

3. **After writing**, immediately retry the original generation request.
   If the key is missing, the tool returns a clear error — relay it verbatim
   to the user then. Not before.

### Provider sanity check before swapping `model`

Before recommending a switch to a new provider, confirm the API key is
already exported. One `shell` call, four chars max so secrets don't
land in transcripts:

```bash
printenv OPENAI_API_KEY | head -c 4
```

Empty output → key is missing; refuse the swap and tell the user
which env var to add to `{OPENAGENTD_CONFIG_DIR}/.env`. Provider →
key var (matches `openagentd init`):

| Provider | Env var |
|----------|---------|
| `anthropic` | `ANTHROPIC_API_KEY` |
| `googlegenai` | `GOOGLE_API_KEY` (agent model **and** image/video generation) |
| `openai` | `OPENAI_API_KEY` |
| `openrouter` | `OPENROUTER_API_KEY` |
| `zai` | `ZAI_API_KEY` |
| `nvidia` | `NVIDIA_API_KEY` |
| `xai` | `XAI_API_KEY` |
| `deepseek` | `DEEPSEEK_API_KEY` |
| `router9` | `ROUTER9_API_KEY` |
| `cliproxy` | `CLIPROXY_API_KEY` |

Providers with managed credentials (`copilot`, `codex`, `bedrock`,
`vertexai`, `ollama`) have no env var to check — `copilot` / `codex` use
their own CLI, `bedrock` uses AWS credentials/ADC, `vertexai` uses ADC,
and `ollama` talks to the local daemon (or to Ollama Cloud after
`ollama signin`). Skip this step for them.

### Relative tweaks ("a bit", "more", "less")

The user says "warmer", "more focused", "more thoughtful" — **read
the current value first**, then nudge by a small delta. Don't pick
absolute numbers from thin air.

| Request | Step (typical) |
|---------|----------------|
| "warmer" / "more creative" | `temperature += 0.2` (cap at `1.0`) |
| "more focused" / "deterministic" | `temperature -= 0.2` (floor at `0.0`) |
| "think harder" | `thinking_level` one rung up: `none → low → medium → high` |
| "respond faster" | `thinking_level` one rung down |

Show the user the before/after numbers in the diff so they can
veto if the delta feels wrong.

## Reload semantics — when changes take effect

Drift detection runs at end of every turn: each member compares
mtimes of `mcp.json`, its own `.md`, and each referenced
`SKILL.md`. If any changed, the agent rebuilds itself in place at
the start of its next turn (model, prompt, tools, MCP — all fresh).
No team teardown, no in-flight turn disruption, no restart.

| Change | Takes effect when |
|--------|-------------------|
| Agent `.md` frontmatter or system prompt | **Next turn** of that agent (drift detection). |
| `mcp.json` (server added / removed / edited) | After `mcp-installer apply`, on the **next turn** of every agent that references the server. |
| `SKILL.md` body edited | **Next turn** of any agent listing the skill (drift detection re-stamps the file). |
| New skill installed via `skill-installer` | Immediately loadable by exact `skill("name")`; the visible skill catalog refreshes on the next catalog/tool-description rebuild. No agent `.md` edit is required. |
| `multimodal.yaml` | Read lazily on every `generate_image` / `generate_video` call — instant. |

The only changes that still require a process restart are: adding or
removing **agent files** themselves (team shape change), manually editing `.env` /
secrets, and code changes. MCP OAuth credentials saved through the MCP API are
an exception: the API updates the current process environment immediately.
Don't claim a restart for anything else.

## Agent frontmatter — fields you may edit

Only these keys are valid. Reject any request to invent new ones.

| Field | Values |
|-------|--------|
| `model` | `provider:model` (provider must be a registered id: `anthropic`, `googlegenai`, `openai`, `openrouter`, `zai`, `nvidia`, `xai`, `deepseek`, `router9`, `cliproxy`, `copilot`, `codex`, `bedrock`, `vertexai`, `ollama`) — e.g. `anthropic:claude-...`, `googlegenai:gemini-...`, `openai:gpt-...`, `zai:glm-...`, `openrouter:...`, `copilot:...`, `codex:...`, `vertexai:...`, `nvidia:...`, `xai:grok-...`, `ollama:...`, `ollama:...-cloud`. Use the exact model id the user names; do not invent version numbers. |
| `temperature` | float, typically `0.0`–`1.0` |
| `thinking_level` | `none` \| `low` \| `medium` \| `high` |
| `tools` | extra tools layered on top of any built-in first-party profile tools: `web_search`, `web_fetch`, `date`, `read`, `write`, `edit`, `patch`, `ls`, `grep`, `glob`, `rm`, `shell`, `bg`, `generate_image`, `generate_video`, plus `<server>_<tool>` entries from configured MCP servers. Never list `skill` or `team_message` — injected automatically. Lead-only tools (`schedule_task`, `todo_manage`) are also injected automatically. |
| `skills` | optional explicit skill metadata/drift hooks; names of discovered skill directories (project/global OpenAgentd, opencode-compatible, or bundled read-only skills). Do not use this as the normal skill-install wiring step. |
| `responses_api` | `true` to force OpenAI Responses API |

Validation invariants to preserve:

- Exactly one file in `agents/` has `role: lead`. Never change `role`.
- `model` must contain a `:` separator.
- Tool names must match the built-in registry (see table above).
- If a skill is listed but not discoverable, the agent still loads but logs `skill_not_found` and omits that skill's instructions — verify before adding.

## `multimodal.yaml` — schema

```yaml
# ── IMAGE ────────────────────────────────────────────────────────────────────
# Option A — OpenAI (DALL·E / GPT image family)
image:
  model: openai:gpt-image-2   # "<provider>:<model>"
  size: 1024x1024             # 1024x1024 | 1536x1024 | 1024x1536 | auto
  quality: auto               # auto | standard | hd | high | medium | low
  output_format: png          # png | jpeg | webp

# Option B — Google GenAI (Gemini image family)
# image:
#   model: googlegenai:gemini-3.1-flash-image-preview
#   aspect_ratio: "1:1"       # 1:1 | 3:4 | 4:3 | 9:16 | 16:9
#   image_size: 1K            # 0.5K | 1K | 2K | 4K

# Option C — OpenAI Codex (ChatGPT Plus/Pro subscription, OAuth)
# image:
#   model: codex:gpt-5.4
#   size: 1024x1024
#   quality: auto
#   output_format: png

# ── VIDEO ────────────────────────────────────────────────────────────────────
# Google GenAI (Veo 3.1) — only registered video backend
video:
  model: googlegenai:veo-3.1-generate-preview
  aspect_ratio: "16:9"        # 16:9 | 9:16
  resolution: "720p"          # 720p | 1080p | 4k  (1080p/4k require duration "8")
  duration_seconds: "8"       # "4" | "6" | "8"
  # person_generation: "allow_adult"
  # negative_prompt: "low quality, blurry"
  # seed: "42"

# audio:    # reserved — not implemented yet
```

Rules:

- The `model` field uses the same `provider:name` format as agent `.md`
  files. The old split shape (separate `provider:` + `model:` keys) is
  **rejected** by the loader.
- Each provider backend owns its credentials — **never** add `api_key_env`
  to the YAML.
- **Registered image providers:**

  | Provider | Auth env var | Notes |
  |----------|--------------|-------|
  | `openai` | `OPENAI_API_KEY` | extras: `size`, `quality`, `output_format` |
  | `googlegenai` | `GOOGLE_API_KEY` | extras: `aspect_ratio`, `image_size` |
  | `codex` | OAuth (`openagentd auth codex`) | rides Responses API; requires ChatGPT Plus/Pro |

- **Registered video providers:**

  | Provider | Auth env var | Notes |
  |----------|--------------|-------|
  | `googlegenai` | `GOOGLE_API_KEY` | Veo 3.1 family; extras: `aspect_ratio`, `resolution`, `duration_seconds`, `person_generation`, `negative_prompt`, `seed` |

- If the user asks for an unregistered provider (`stability:*`, `replicate:*`, etc.),
  **refuse** and suggest a registered alternative.
- Before recommending any provider, confirm its env var (or OAuth token) is
  present: `printenv <VAR> | head -c 4`. For `codex`, check the OAuth cache
  file instead of an env var.
- Keep `extras` keys as plain strings (they are passed through to the backend
  as-is).
- The same `image.model` powers both text-to-image (`generate_image(prompt=...)`)
  and image editing (`generate_image(prompt=..., images=[...])`). No separate
  config entry needed for edit mode.

## MCP tools on agents

MCP servers are managed by `mcp-installer` (it edits `mcp.json`). This
skill wires the resulting tools onto a specific agent. For first-party
built-in profiles, `mcp:` and selective server-prefixed MCP tools in the `.md` are
additive local overrides; they do not replace built-in capabilities.

The recipes below are for agent `.md` edits, including lead targets and
selective `tools:` entries.

Two ways:

### `mcp:` list — bulk attach (recommended for new servers)

Grants the agent **every** tool the server exposes, now and in the
future. One line; future server-side tool additions are picked up
automatically.

```yaml
mcp:
  - context7
  - shadcn          # ← grants all shadcn tools
```

### `tools:` list — selective attach

Pick specific `<server>_<tool>` names. Use when the agent only
needs one or two tools from a multi-tool server.

```yaml
tools:
  - read
  - shell
  - shadcn_get_component
```

| User intent | Action |
|-------------|--------|
| "Let me use the shadcn MCP" | Add `shadcn` to `mcp:` (bulk) |
| "Add only the search tool from filesystem" | Add `filesystem_search` to `tools:` |
| "Remove the github MCP from this agent" | Strip `github` from `mcp:` AND every `github_*` entry from `tools:` |

### Workflow

1. **Verify the server is configured and `ready`:**
   ```bash
   curl -sS http://localhost:4082/api/mcp/servers/<name> | jq '{state, tool_names}'
   ```
   - If `ready`: proceed.
   - If `starting`: wait a moment and retry once.
   - If `error`, `auth_required`, or absent from `mcp.json`: **delegate to `mcp-installer`** first.
   - If the daemon is unreachable: proceed anyway — add the `mcp:` entry to the agent file and note it takes effect on the next turn.

2. **For selective `tools:` entries**, pick names from `tool_names`.
   Don't invent names.

3. **Standard diff workflow** (read → diff → confirm → edit). Active
   on the agent's next turn — no reload step.

4. **Removal ordering** — when removing tools as part of decommissioning
   the server itself, edit agent files **before** running
   `mcp-installer apply`. Otherwise the next-turn rebuild logs
   `agent_config_refresh_failed` ("unknown tool") and the agent keeps
   its previous (stale) config until you fix it. `mcp-installer`
   delegates here for exactly this reason.

## Delegating to `skill-installer`

If the user wants a **new** skill body — "install a code-review skill",
"add a skill for generating SVGs", "fetch this skill from https://…" — call
`skill("skill-installer")` and follow its workflow. Do not write `SKILL.md`
files from inside this skill, and do not edit agent `.md` `skills:` lists unless
the user explicitly asked for that metadata change.

## Examples

### 1. "Switch yourself to gpt-5 with medium thinking"

Read the lead agent's file (e.g. `agents/openagentd.md`), show:

```diff
- model: zai:glm-5v-turbo
- thinking_level: low
+ model: openai:gpt-5
+ thinking_level: medium
```

Apply with `edit`. Tell user: "Applied. Active on my next turn."

### 2. "Use Gemini for image generation"

Confirm `GOOGLE_API_KEY` is set, then read `multimodal.yaml` and show:

```diff
  image:
-   model: openai:gpt-image-2
-   size: 1024x1024
-   quality: auto
-   output_format: png
+   model: googlegenai:gemini-3.1-flash-image-preview
+   aspect_ratio: "1:1"
+   image_size: 1K
```

Apply. Note that `size`/`quality`/`output_format` are OpenAI-only extras and
must be replaced with `aspect_ratio`/`image_size` (GoogleGenAI extras) — leaving
stale keys is harmless (they are ignored by the backend) but confusing; remove
them for clarity.

### 3. "Generate sharper images"

Read `multimodal.yaml`, show:

```diff
   size: 1024x1024
-  quality: auto
+  quality: high
```

Apply. Tell user: "Applied. Takes effect on the next `generate_image` call —
no restart needed."

### 4. "Give yourself shell access"

Read the current agent's `.md`, add `shell` (and probably `bg`) to the
`tools:` list. Show diff, confirm, apply. Warn: "Shell runs inside the
sandbox and is gated by the permission system."

### 5. "Install a skill for writing release notes"

Delegate: call `skill("skill-installer")` and follow that workflow.

### 6. "Be a bit warmer"

Read the lead's `.md` (current `temperature: 0.4`), nudge by `+0.2`:

```diff
- temperature: 0.4
+ temperature: 0.6
```

Show the user the absolute numbers, not just "+0.2", so the cap (1.0)
and floor (0.0) are obvious. Apply and confirm "Active on my next turn."

## Failure modes — bail out instead of guessing

- Target file not found → ask the user to confirm the path / agent name.
- Frontmatter malformed (no closing `---`, YAML parse error) → show the
  problem, do not attempt repair unless asked.
- User request violates an invariant (two leads, unknown tool, unsupported
  provider) → explain why and suggest the nearest valid alternative.
- Env var for a new provider isn't set → refuse to switch; tell the user
  what key is needed and where to put it (`{OPENAGENTD_CONFIG_DIR}/.env`).
