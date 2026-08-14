---
name: skill-installer
description: >-
  Install new skills into the agent's skills directory by fetching from a URL
  or writing from scratch.
---

# Skill Installer

Use this skill when the user wants to add a **new skill body**. Do not use it
for changing models, tools, MCP servers, plugins, or other agent configuration.

## Discovery order

OpenAgentd discovers skills from these roots, in order. The first skill with a
given `name` wins (`{workspace}` is the active sandbox workspace root — in
**coding mode** that is the attached workspace dir, not the daemon's cwd):

1. `{workspace}/.openagentd/skills/{skill-name}/SKILL.md`
2. `{workspace}/.opencode/skills/{skill-name}/SKILL.md`
3. `{SKILLS_DIR}/{skill-name}/SKILL.md`  (global, typically `{OPENAGENTD_CONFIG_DIR}/skills`)
4. `~/.config/opencode/skills/{skill-name}/SKILL.md`
5. Bundled OpenAgentd operational skills — read-only fallback.

Default to `{SKILLS_DIR}` (global — available in both normal and coding modes)
unless the user explicitly asks for a project-local skill, in which case write to
`{workspace}/.openagentd/skills/`. If the target name exists only as a bundled
skill, install a writable override; never edit bundled files.

**Resolving the two writable roots concretely** (`{workspace}` is *not* an
auto-substituted token — only `{SKILLS_DIR}`, `{OPENAGENTD_CONFIG_DIR}`,
`{AGENTS_DIR}`, `{SKILL_DIR}` expand):

- **Project-local** → `{workspace}` is your current sandbox root. In coding mode
  that is the attached workspace (the repo you are operating in), and it is your
  shell cwd — so write to `.openagentd/skills/{name}/SKILL.md` (relative), or run
  `pwd` once to get the absolute path. Do not invent a path.
- **Global** → `{SKILLS_DIR}` is already a concrete absolute path; use it as-is.

Decide which the user meant: "project / repo / this workspace / local skill"
→ project-local; "for yourself / globally / everywhere / all projects"
→ global. If genuinely ambiguous, ask one short question — the two roots are not
interchangeable (a project-local skill is invisible from other workspaces).

## Skill file format

A skill is a directory containing at minimum a `SKILL.md` file with YAML
frontmatter and a Markdown body:

```markdown
---
name: skill-name
description: One-sentence description shown in the skill registry.
---

# Skill Title

Full instructions the agent reads when it calls skill("skill-name").
```

Rules:

- Directory name should match the `name` field for flat skills.
- Prefer lowercase kebab-case names unless the user intentionally wants a
  one-level namespace such as `oad/debug`.
- Keep `description:` short and trigger-oriented.
- Never overwrite an existing skill without reading it first and confirming with
  the user.

## How to install

### From a URL

1. Fetch the raw content with `web_fetch`.
2. If the response is HTML, ask for the raw URL and stop.
3. Parse the frontmatter `name` field; that is the skill name.
4. Write the content to the selected writable skill root.
5. Read it back to verify the file landed correctly.
6. Confirm the exact path and skill name.

### From scratch

1. Ask what the skill should do only if the request does not already specify it.
2. Choose the root (see "Discovery order" above): project-local
   `.openagentd/skills/{name}/SKILL.md` (relative to the workspace cwd) for a
   "project / repo" skill, or `{SKILLS_DIR}/{name}/SKILL.md` for a global one.
3. Write the `SKILL.md` following the format above. The `patch` tool creates
   parent directories, so the skill directory does not need to exist first.
4. Add supporting files in the same directory only if they are useful.
5. Read it back to verify the file landed correctly.
6. Confirm the exact resolved path and skill name (run `pwd` first if you wrote a
   relative project-local path, so you report the absolute location).

A new skill can be loaded by exact name immediately — the file tools clear the
discovery cache on write for both global and project-local roots.
