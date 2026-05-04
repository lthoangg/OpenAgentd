---
name: skill-installer
description: >-
  Install new skills into the agent's skills directory by fetching from a URL
  or writing from scratch.
---

# Skill Installer

## Skill file format

A skill is a directory at `{SKILLS_DIR}/{skill-name}/` containing at minimum a `SKILL.md` file. The `SKILL.md` has YAML frontmatter and a Markdown body:

```markdown
---
name: skill-name
description: One-sentence description shown in the system prompt.
---

# Skill Title

Full instructions the agent reads when it calls skill("skill-name").
```

## How to install

### From a URL

1. Fetch the raw content with `web_fetch`.
2. Parse out the frontmatter `name` field — that becomes the directory name.
3. Write the content to `{SKILLS_DIR}/{name}/SKILL.md`.

### From scratch

1. Ask the user what the skill should do if not already specified.
2. Write a `SKILL.md` following the format above to `{SKILLS_DIR}/{name}/SKILL.md`.
3. Create any supporting files (e.g. `reference.md`) in the same directory if useful.

## Rules

- Directory name must match the `name` field in frontmatter (lowercase, hyphens only).
- Never overwrite an existing skill without confirming with the user first — read it first and show what will change.
- After writing, confirm the path and name so the user can add it to an agent's `skills:` list.
- A new skill can be loaded by exact name immediately. It appears in generated "Available skills" sections after the affected agent rebuilds on its next turn; if a cached skill catalog is stale, use the Skills API/UI path or restart as a fallback.
