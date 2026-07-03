---
title: Skills
description: SKILL.md format, registration, and the builtin skill catalog.
status: stable
updated: 2026-05-29
---

# Skills

**Source:** `app/agent/tools/builtin/skill.py`, `app/agent/builtin_skills/`

Skills are domain-specific instruction sets that an agent loads **on demand** via the `skill` tool, rather than carrying their full text in the system prompt at all times. The framework injects only each skill's one-line `description:` into the system prompt as a registry the agent can browse.

## Layout

Each skill lives in its own subdirectory. One nested namespace level is also
supported:

```
{OPENAGENTD_CONFIG_DIR}/skills/
├── my-skill/
│   ├── SKILL.md          ← required — frontmatter + body
│   ├── creating.md       ← optional supporting files the agent can read
│   └── reference/        ← optional subdir with extra reference material
└── oad/
    └── debug/
        └── SKILL.md      ← registers as oad/debug
```

Deeper layouts such as `skills/a/b/c/SKILL.md` are ignored by discovery.

### Discovery roots

Skills are discovered from five roots in this precedence order — first match
wins on a name collision, so an OpenAgentd-native override silently shadows
the upstream or builtin copy:

| # | Root | Use it for |
|---|------|------------|
| 1 | `{workspace}/.openagentd/skills/`     | Project-specific, OpenAgentd-native |
| 2 | `{workspace}/.opencode/skills/`       | Project-specific, opencode reuse |
| 3 | `{OPENAGENTD_CONFIG_DIR}/skills/` | Your global OpenAgentd library |
| 4 | `~/.config/opencode/skills/`    | Your global opencode library (reused as-is) |
| 5 | bundled OpenAgentd skills | Read-only operational fallback shipped with the app |

`{workspace}` is the active coding workspace when a session has one; outside a
session it falls back to the server working directory. The Settings UI lists the
same runtime-visible catalog. Non-bundled skills are
edited and deleted in place, including project-local and opencode skills.
Bundled app skills are read-only and cannot be deleted.

`SKILL.md` follows this layout:

```markdown
---
name: my-skill
description: >-
  One-sentence description shown in the system prompt registry.
---

# My Skill

The full instructions the agent reads when it calls `skill("my-skill")`.
```

- The frontmatter is **not** returned to the agent — only the body below.
- The skill is identified by the frontmatter `name`. If absent, the directory stem is used (`my-skill` or `parent/sub`).
- **Frontmatter parsing is forgiving at load time.** A common quirk — an
  unquoted `description:` whose text contains `": "` (e.g. `Typical jobs:
  release clips`) — is invalid YAML, yet discovery recovers the flat
  `key: value` pairs instead of dropping the skill or crashing startup.
  The **`/settings/skills` write API stays strict** and rejects malformed
  frontmatter with a `422`, so prefer quoting or a `>-` block scalar when
  authoring. Recovery exists only so one bad file can never take the whole
  catalog (and the agents that load tools from it) offline.

## Using a skill from an agent

Skills are discovered from the roots above and exposed through the `skill` tool's
available-skills catalog. Installing a skill into one of those roots is normally
enough.

The `skills:` frontmatter field still exists for explicit agent metadata and
file-drift tracking, but it is additive and not the normal install path:

```yaml
skills:
  - my-skill
  - oad/debug
```

The `skill` tool itself is **always injected** into every agent — do not list it in `tools:`.

## Builtin skills

OpenAgentd ships these read-only operational skills inside the app package. They cannot be deleted from Settings or the skills API. A user or project skill with the same `name` overrides the builtin copy.

| Name | Purpose |
|------|---------|
| `self-healing` | Update agent/runtime config on request — swap model, tune thinking level, add tools/MCP, change image-gen provider. |
| `skill-installer` | Install new skills from a URL or write one from scratch. |
| `browser-use` | Automate browser interactions for web testing, form filling, screenshots, and data extraction. |

> Other curated skills (office documents, lightpanda, etc.) are not builtin and must be installed manually via `skill-installer` or by dropping a `SKILL.md` into the skills directory.

## Reference Files and Scripts (agentskills.io)

OpenAgentd supports the [agentskills.io](https://agentskills.io) specification, allowing skills to bundle supporting documentation (`references/`), static assets (`assets/`), and executable scripts (`scripts/`):

```
my-skill/
├── SKILL.md                 # Required: core instructions
├── references/              # Supporting documentation
│   └── API_SPEC.md
├── scripts/                 # Executable scripts
│   └── validate.py
└── assets/                  # Templates and static assets
    └── template.json
```

### Path Resolution: `{SKILL_DIR}` and `${SKILL_DIR}`

When a skill is loaded via the `skill` tool, OpenAgentd automatically replaces any occurrences of `{SKILL_DIR}` or `${SKILL_DIR}` in the skill's instructions with the resolved directory path:

- **Project Skills:** If the skill is located inside the active coding workspace (e.g., `.openagentd/skills/my-skill`), the path is resolved as a **relative path** from the workspace root (e.g., `.openagentd/skills/my-skill`).
- **Global & Bundled Skills:** If the skill is located outside the workspace (e.g., in the global user configuration or bundled within the app), the path is resolved as an **absolute path** (e.g., `/Users/username/.config/openagentd/skills/my-skill`).

### Using Standard Tools

The agent interacts with skill assets using its standard, general-purpose tools (like `read` and `shell`) via the resolved paths:

* **Reading Reference Files:**
  ```python
  # Resolved to absolute path for a global skill
  read(path="/Users/username/.config/openagentd/skills/my-skill/references/API_SPEC.md")

  # Resolved to relative path for a project skill
  read(path=".openagentd/skills/my-skill/references/API_SPEC.md")
  ```

* **Running Scripts:**
  ```bash
  # Resolved to absolute path for a global skill
  python3 /Users/username/.config/openagentd/skills/my-skill/scripts/validate.py --input data.json

  # Resolved to relative path for a project skill
  python3 .openagentd/skills/my-skill/scripts/validate.py --input data.json
  ```

## Authoring guidelines

- **One paragraph in `description`.** It goes into every system prompt registered with the skill — keep it tight.
- **Body is what the LLM reads when `skill(name)` is called.** Be explicit about steps, expected output, common pitfalls.
- **Supporting files** (`creating.md`, `reference/`, etc.) are reachable by the agent's filesystem tools as long as the workspace allows it — the skill body should reference them by relative path.
- **Hot reload.** `discover_skills()` is cached via `lru_cache` keyed by an mtime signature across all discovery roots. Additionally, the agent's file tools (`write`, `edit`, `patch`, `rm`) eagerly clear this cache whenever a path under *any* skill root is touched — including project-local roots (`.openagentd/skills/`, `.opencode/skills/`). This means a skill written or deleted within a turn is visible to the next `discover_skills()` call in that same turn, without relying on filesystem mtime granularity or a server restart.
