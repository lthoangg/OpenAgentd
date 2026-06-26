# seed/

Default agents, optional skills, and file-based configuration shipped to first-time users.

When a user runs `openagentd init`, the CLI copies the contents of this
directory (locally if running from a source checkout, otherwise from the
published GitHub release / `main` branch) into
`{OPENAGENTD_CONFIG_DIR}/`.

Updating these files affects every **new** install. Existing users keep
their own copies untouched — once `openagentd init` has populated their
config dir, those files are theirs to edit. Users who want the newest
prompts or skills can browse this directory and copy what they want
into their own `{OPENAGENTD_CONFIG_DIR}/`.

## Layout

```
seed/
├── agents/                # default global/coding agent descriptors
├── skills/                # optional user-editable skills; currently empty
└── mcp.json               # empty MCP server config
```

> Summarisation and title generation prompts are built in and are not
> seeded as editable prompt files. Runtime choices such as enable/model/schedule
> live in `{OPENAGENTD_CONFIG_DIR}/settings.yaml`, which the app creates from
> the known schema instead of copying from `seed/`. `multimodal.yaml` is also
> generated from a known schema rather than copied from GitHub seed content.

`README.md` (this file) is the only top-level item not copied — every
other top-level entry ships, but `init` skips files the user already
has, so re-running `init` after a release won't clobber edits.

## Conventions

- **Lead agent first.** `agents/openagentd.md` is the lead; the others are members.
- **Model placeholder.** Every agent's `model:` field is rewritten by
  `openagentd init` to match the provider/model the user picked. The same
  selected model is written into generated `settings.yaml` for title generation.
  After install, users can run `self-healing` to swap individual member
  models (e.g. give the executor a faster model than the lead).
- **No secrets, ever.** These files are public. `mcp.json` should
  reference env vars (`${VAR}`) for any auth headers, never inline
  values.
- **Keep skills self-contained.** Each `skills/<name>/` should run with no
  outside files. Bundle reference scripts and templates in the same dir.
- **Top-level configs are fill-in-gap defaults.** `mcp.json` only lands if the
  target file doesn't exist. Generated configs (`settings.yaml`,
  `multimodal.yaml`) follow the same no-overwrite rule.
