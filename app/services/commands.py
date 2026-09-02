"""Slash-command discovery and rendering.

Commands are markdown files with YAML frontmatter, reused from opencode's
format so users can share a single library between the two tools:

    ---
    description: One-line description shown in the picker
    ---

    Body becomes the user message. ``$ARGUMENTS`` (if present) is
    replaced with whatever the user typed after the command name; if
    the placeholder is absent, the arguments are appended on a new line.

Discovery walks four roots in precedence order — first hit wins on a
name collision, later sources are silently ignored:

    1. ``{workspace}/.openagentd/commands/``  (project, OpenAgentd-native;
                                               coding mode only)
    2. ``{workspace}/.opencode/commands/``    (project, opencode reuse;
                                               coding mode only)
    3. ``{OPENAGENTD_CONFIG_DIR}/commands/``     (global, OpenAgentd)
    4. ``~/.config/opencode/commands/`` (global, opencode reuse)

Nested folders are honoured: ``commands/git/commit.md`` registers as
``git/commit`` so users can group related commands. The forward slash
is preserved verbatim in the command id — the picker matches against it.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path

import yaml

from app.core.config import settings


@dataclass(frozen=True)
class Command:
    """A discovered slash command."""

    name: str  # e.g. "commit" or "git/commit"
    description: str
    body: str  # post-frontmatter markdown, untouched
    path: Path  # absolute path to the source .md file
    source: str  # one of: project-openagentd / project-opencode / global-openagentd / global-opencode


# ── Discovery roots ─────────────────────────────────────────────────────────


def _candidate_roots(workspace: Path | None = None) -> list[tuple[Path, str]]:
    """Ordered list of ``(root_dir, source_label)`` to search.

    Roots that don't exist are still returned — the caller filters them
    out — so the precedence rule is deterministic regardless of which
    sources happen to be present on disk.
    """
    home = Path.home()
    config = Path(settings.OPENAGENTD_CONFIG_DIR)
    roots: list[tuple[Path, str]] = []
    if workspace is not None:
        roots.extend(
            [
                (workspace / ".openagentd" / "commands", "project-openagentd"),
                (workspace / ".opencode" / "commands", "project-opencode"),
            ]
        )
    roots.extend(
        [
            (config / "commands", "global-openagentd"),
            (home / ".config" / "opencode" / "commands", "global-opencode"),
        ]
    )
    return roots


# ── Parsing ─────────────────────────────────────────────────────────────────

_FRONTMATTER_RE = re.compile(r"^---\s*\n(.*?)\n---\s*\n(.*)$", re.DOTALL)
_MAX_CACHED_COMMAND_PARSES = 256
_MAX_CACHED_COMMAND_BYTES = 128 * 1024


def _parse_frontmatter(text: str) -> tuple[dict, str]:
    """Split YAML frontmatter from markdown body.

    Mirrors ``app.agent.tools.builtin.skill._parse_frontmatter`` — kept
    private here to avoid a cross-package import that would pull the
    skill tool's settings into ``services``.
    """
    match = _FRONTMATTER_RE.match(text)
    if not match:
        return {}, text.strip()
    meta = yaml.safe_load(match.group(1)) or {}
    if not isinstance(meta, dict):
        meta = {}
    return meta, match.group(2).strip()


def _read_command_file(path: Path) -> tuple[str, str]:
    text = path.read_text(encoding="utf-8")
    meta, body = _parse_frontmatter(text)
    description = meta.get("description", "")
    if not isinstance(description, str):
        description = ""
    return description.strip(), body


@lru_cache(maxsize=_MAX_CACHED_COMMAND_PARSES)
def _parse_command_file(
    path: Path, _signature: tuple[int, int, int, int, int]
) -> tuple[str, str]:
    """Read and parse a command file identified by its stat signature."""
    return _read_command_file(path)


def _cached_command_content(path: Path) -> tuple[str, str] | None:
    """Return parsed command content, reusing an unchanged file's result."""
    try:
        stat = path.stat()
    except OSError:
        return None
    try:
        if stat.st_size > _MAX_CACHED_COMMAND_BYTES:
            return _read_command_file(path)
        signature = (
            stat.st_mtime_ns,
            stat.st_ctime_ns,
            stat.st_size,
            stat.st_mode,
            stat.st_ino,
        )
        return _parse_command_file(path, signature)
    except OSError:
        return None


def _iter_md(root: Path):
    """Yield ``(absolute_path, command_name)`` for every ``*.md`` under *root*.

    The command name is the path relative to *root* with the ``.md``
    suffix stripped.  Only one level of nesting is honoured:

    * ``commands/commit.md``         → ``"commit"``
    * ``commands/git/commit.md``     → ``"git/commit"``
    * ``commands/a/b/c.md``          → skipped (more than one level deep)

    Files nested more than one level deep are silently ignored so the
    command namespace stays predictable and the slash-picker UI remains
    manageable.
    """
    if not root.is_dir():
        return
    for path in sorted(root.rglob("*.md")):
        if not path.is_file():
            continue
        rel = path.relative_to(root).with_suffix("")
        # Allow at most one level of nesting (i.e. at most 2 path parts).
        if len(rel.parts) > 2:
            continue
        # ``as_posix`` normalises separators on Windows so command ids
        # stay platform-independent.
        yield path, rel.as_posix()


# ── Built-in commands ───────────────────────────────────────────────────────
#
# Built-ins are prompt templates owned by OpenAgentd itself rather than the
# user's command library. They are intentionally **not** listed by
# ``discover_commands`` — the picker registers them as immediate-execute
# actions (see the agent chat view's ``slashCommands``) — but they are
# resolvable through :func:`get_builtin_command` and the
# ``/api/commands/{name}/render`` endpoint so the frontend can fetch the
# rendered body without hardcoding the prompt in the bundle.

_BUILTIN_INIT_BODY = """\
# AGENTS.md Repository Analyzer & Generator

You are responsible for analyzing this repository and creating, updating, and validating its `AGENTS.md` instruction hierarchy.

Your goal is **not to summarize the repository**.

Your goal is to make the repository easy, safe, and efficient for AI coding agents to work in by providing concise, accurate, evidence-backed operational instructions.

Treat `AGENTS.md` as an **operational map for coding agents**, not as a README, architecture encyclopedia, or generic coding guide.

The final result should help a fresh coding agent quickly understand:

- how to install and run the repository,
- how to test, lint, format, typecheck, and build changes,
- where different kinds of code belong,
- which architectural boundaries must be preserved,
- which repository-specific conventions matter,
- which files or directories should not be modified casually,
- how different subprojects differ,
- which deeper documentation should be consulted,
- and what checks must be completed before a change is considered done.

---

# 1. Core Principles

Follow these principles throughout the task.

## 1.1 Evidence Over Assumptions

Never invent repository conventions.

Every meaningful instruction should be backed by repository evidence such as:

- CI workflows,
- build scripts,
- package manifests,
- lockfiles,
- test configuration,
- lint configuration,
- formatting configuration,
- typechecking configuration,
- actual tests,
- representative implementation code,
- architecture documentation,
- contribution documentation,
- existing `AGENTS.md` files,
- existing agent instructions.

Do not add generic advice just because it sounds like good engineering.

Bad:

```md
- Write clean code.
- Follow SOLID principles.
- Use meaningful variable names.
- Follow best practices.
```

Good:

```md
- Keep HTTP handlers thin; application logic belongs in `src/services/`.
- Database access goes through repositories under `src/repositories/`.
- Run `uv run pytest` before completing backend changes.
```

If something cannot be verified:

1. omit it when possible,
2. mark it as uncertain if it is important,
3. never present an inference as a confirmed repository rule.

---

## 1.2 Prefer Executable Truth

When repository sources disagree, use approximately this priority:

1. CI workflows and executable automation
2. Makefiles, Taskfiles, Justfiles, package scripts, shell scripts
3. package/build manifests and lockfiles
4. test configuration and actual tests
5. actual implementation patterns
6. architecture and contribution documentation
7. README files
8. comments
9. LLM inference

For example, if:

```text
README:
pytest
```

but CI executes:

```text
uv run pytest
```

prefer:

```text
uv run pytest
```

If the discrepancy appears meaningful, mention the potentially stale documentation in the final report.

---

## 1.3 Root = Defaults, Child = Delta

Multiple `AGENTS.md` files are a first-class design.

Treat nested files as a hierarchy of scoped instructions.

Conceptually:

```text
effective instructions
    =
root instructions
    + parent instructions
    + nearest child instructions
```

More specific instructions apply to narrower scopes.

Child files should generally describe **local differences**, not duplicate the entire parent file.

Think:

```text
child = parent + local delta
```

not:

```text
child = standalone repository manual
```

---

## 1.4 Keep Context Small

Optimize for high signal-to-noise.

The root `AGENTS.md` should normally be approximately:

```text
50–150 lines
```

This is a guideline, not a hard limit.

A complex repository may justify somewhat more, but avoid creating enormous instruction files.

Nested `AGENTS.md` files should usually be even smaller.

Prefer progressive disclosure:

```text
AGENTS.md
    ↓
docs/ARCHITECTURE.md
docs/TESTING.md
docs/SECURITY.md
DESIGN.md
...
```

Do not copy entire documentation files into `AGENTS.md`.

---

## 1.5 Document Meaning, Not Trivia

Do not dump information agents can trivially inspect.

Avoid:

- complete dependency lists,
- package versions unless operationally important,
- full repository trees,
- every environment variable,
- every endpoint,
- every class,
- every source file,
- every package script,
- every configuration option.

Bad:

```md
## Files

- `src/foo.py`
- `src/bar.py`
- `src/baz.py`
- `src/qux.py`
```

Better:

```md
## Architecture

- `src/api/` owns the HTTP boundary.
- `src/services/` owns application logic.
- `src/storage/` owns persistence.
```

Explain **why a location matters**.

---

## 1.6 Prioritize High-Value Instructions

Prefer information in roughly this order:

1. hard constraints
2. prohibited or dangerous modifications
3. architectural boundaries
4. exact development commands
5. validation commands
6. repository-specific coding conventions
7. testing expectations
8. important navigation
9. deeper documentation references
10. descriptive project information

---

# 2. Phase One — Discover Existing Instructions

Before analyzing individual subprojects, discover all existing agent instruction files.

Search for:

```text
AGENTS.md
```

across the entire repository.

Also inspect potentially related instruction files where present, such as:

```text
CLAUDE.md
GEMINI.md
.github/copilot-instructions.md
.cursor/rules/
.cursor/rules/*.mdc
.windsurfrules
```

Do not automatically copy those files into `AGENTS.md`.

Use them as evidence of intentional repository guidance, then verify important instructions against the repository itself.

Build an internal map of all `AGENTS.md` files.

Example:

```text
/AGENTS.md
/backend/AGENTS.md
/frontend/AGENTS.md
/packages/AGENTS.md
/packages/auth/AGENTS.md
```

Determine the scope of every file.

Conceptually:

```json
{
  "/AGENTS.md": {
    "scope": "/",
    "parent": null
  },
  "/backend/AGENTS.md": {
    "scope": "/backend",
    "parent": "/AGENTS.md"
  },
  "/packages/AGENTS.md": {
    "scope": "/packages",
    "parent": "/AGENTS.md"
  },
  "/packages/auth/AGENTS.md": {
    "scope": "/packages/auth",
    "parent": "/packages/AGENTS.md"
  }
}
```

Read all existing `AGENTS.md` files before modifying any of them.

---

# 3. Phase Two — Inspect Repository Tooling

Inspect high-confidence machine-readable and executable sources first.

Look for files such as:

```text
package.json
package-lock.json
pnpm-lock.yaml
pnpm-workspace.yaml
yarn.lock
bun.lock
bun.lockb

pyproject.toml
uv.lock
requirements.txt
requirements-*.txt
Pipfile
poetry.lock
tox.ini
pytest.ini
ruff.toml
mypy.ini

Cargo.toml
Cargo.lock

go.mod
go.sum

Makefile
Justfile
Taskfile.yml

Dockerfile
Dockerfile.*
docker-compose.yml
docker-compose.yaml
compose.yml
compose.yaml

.github/workflows/
.gitlab-ci.yml

tsconfig.json
tsconfig.*.json
eslint.config.*
.eslintrc*
biome.json

pre-commit-config.yaml
.pre-commit-config.yaml

turbo.json
nx.json
lerna.json

README.md
README.*
CONTRIBUTING.md
ARCHITECTURE.md
DESIGN.md
SECURITY.md

docs/
scripts/
```

Do not assume this list is exhaustive.

Adapt to the repository.

---

# 4. Phase Three — Build an Internal Repository Model

Before writing any `AGENTS.md`, build an internal evidence-backed profile of the repository.

Do not necessarily write this profile to disk.

Determine the following.

---

## 4.1 Project Topology

Identify:

- primary languages,
- frameworks,
- package managers,
- build systems,
- workspace/monorepo tooling,
- deployable applications,
- libraries,
- shared packages,
- generated packages,
- infrastructure components,
- desktop/mobile/web/backend boundaries where applicable.

Example conceptual model:

```yaml
repository:
  type: monorepo

projects:
  backend:
    language: python
    package_manager: uv
    framework: fastapi

  frontend:
    language: typescript
    package_manager: bun
    framework: react

  desktop:
    language: rust
    framework: tauri
```

Do not put this full structure into `AGENTS.md` unless useful.

It exists to help your reasoning.

---

## 4.2 Development Commands

Determine exact commands for applicable workflows:

- dependency installation,
- development server,
- build,
- production build,
- tests,
- targeted tests,
- integration tests,
- end-to-end tests,
- lint,
- formatting,
- format checking,
- type checking,
- code generation,
- database migrations,
- schema generation,
- documentation generation,
- relevant validation scripts.

Record provenance internally.

Example:

```yaml
test:
  command: uv run pytest
  evidence:
    - .github/workflows/test.yml
    - pyproject.toml

lint:
  command: uv run ruff check .
  evidence:
    - pyproject.toml
    - Makefile
```

Only document commands that actually exist or can be strongly derived from repository evidence.

---

## 4.3 Architecture

Determine the repository's major architectural boundaries.

Possible examples:

```text
API boundary
application/service layer
domain layer
persistence layer
agent runtime
tool/plugin system
event system
frontend state
desktop bridge
shared libraries
infrastructure
generated clients
```

Inspect representative implementation files rather than blindly reading every source file.

Determine:

- dependency direction,
- ownership of responsibilities,
- where new logic should go,
- where logic should not go,
- cross-package dependency constraints.

---

## 4.4 Established Coding Patterns

Inspect representative code and tests.

Look for deliberate, repeated patterns such as:

- dependency injection,
- repository/service patterns,
- schema/model separation,
- async conventions,
- error handling,
- result types,
- logging,
- configuration access,
- frontend state ownership,
- data fetching,
- API routing,
- component structure,
- package imports,
- module boundaries,
- naming conventions,
- test organization,
- fixtures,
- mocking,
- factories,
- database transaction handling,
- serialization,
- migration patterns.

Only document patterns that appear sufficiently established.

Do not infer a repository-wide rule from one isolated implementation.

---

## 4.5 Repository Constraints

Identify areas where an agent could easily cause damage or unnecessary churn.

Look for:

- generated code,
- generated schemas,
- generated clients,
- vendored dependencies,
- migrations,
- snapshots,
- lockfiles,
- protocol definitions,
- compatibility-sensitive APIs,
- security-sensitive modules,
- serialization formats,
- public interfaces,
- release artifacts,
- checked-in generated output,
- submodules,
- platform-specific files,
- manually synchronized files.

Examples of useful constraints:

```md
- Do not manually edit files under `src/generated/`; regenerate them with `...`.
- Existing released migrations are immutable; create a new migration instead.
- Do not import frontend packages from `packages/core/`.
```

Only add them when repository evidence supports them.

---

# 5. Phase Four — Determine Instruction Scopes

Decide which instructions belong at which level.

Use the **narrowest useful scope** without creating unnecessary fragmentation.

---

## 5.1 Root AGENTS.md

The root file should contain repository-wide information such as:

- global repository purpose,
- major project boundaries,
- shared development workflow,
- global architectural invariants,
- common validation expectations,
- repository-wide safety constraints,
- navigation to important subprojects,
- navigation to deeper documentation.

Do not put backend-only, frontend-only, or package-only instructions in the root unless they are needed for repository navigation.

---

## 5.2 Nested AGENTS.md

Create or retain nested files when a subtree has materially different:

- language,
- toolchain,
- package manager,
- commands,
- architecture,
- testing strategy,
- conventions,
- constraints,
- development workflow.

Examples:

```text
/
├── AGENTS.md
├── backend/
│   └── AGENTS.md
├── frontend/
│   └── AGENTS.md
└── desktop/
    └── AGENTS.md
```

Nested files should mainly contain local additions or overrides.

For example:

Root:

```md
- Run checks relevant to every package you modify.
- Never commit secrets.
```

Backend:

```md
- Use `uv sync` for dependency management.
- Run `uv run pytest`.
- Keep HTTP handlers thin; business logic belongs in `services/`.
```

Frontend:

```md
- Use Bun for dependency management.
- Run `bun test`.
- Use TanStack Query for server state.
```

Do not unnecessarily repeat root rules inside children.

---

## 5.3 Deciding Whether a Rule Is Global

Use this heuristic:

```text
Does the rule apply to most of the repository?
        |
       yes
        |
        v
root AGENTS.md

Otherwise:
        |
        v
nearest meaningful child scope
```

Examples:

```text
"Never commit credentials."
→ root

"Python dependencies are managed with uv."
→ backend/

"React server state uses TanStack Query."
→ frontend/

"Tauri commands return AppResult<T>."
→ desktop/

"Authentication packages must not depend on UI packages."
→ packages/auth/
```

Use judgment rather than mechanically applying a percentage.

---

# 6. Nested AGENTS.md Resolution

For any path, determine the full applicable instruction chain.

Example:

```text
repo/
├── AGENTS.md
└── packages/
    ├── AGENTS.md
    └── auth/
        ├── AGENTS.md
        └── src/
            └── token.ts
```

For:

```text
packages/auth/src/token.ts
```

the applicable instruction chain is:

```text
/AGENTS.md
    ↓
/packages/AGENTS.md
    ↓
/packages/auth/AGENTS.md
```

Treat deeper files as more specific.

If instructions conflict:

1. determine whether the child intentionally specializes the parent,
2. inspect repository evidence,
3. preserve intentional local specialization,
4. fix stale or accidental contradictions,
5. report unresolved ambiguity.

Do not silently discard constraints.

---

# 7. Existing AGENTS.md Handling

If instruction files already exist, do not blindly regenerate them.

For every existing file, determine:

- which instructions are accurate,
- which instructions are stale,
- which instructions are duplicated,
- which instructions are generic noise,
- which instructions belong in a parent,
- which instructions belong in a child,
- which important instructions are missing,
- which apparent contradictions are intentional overrides.

Preserve intentional human-authored guidance where it remains valid.

Do not rewrite merely for stylistic consistency.

Prefer minimal, meaningful improvements.

---

# 8. Deduplicate Parent and Child Instructions

Detect duplication across the hierarchy.

Bad:

```text
/AGENTS.md
    Never commit secrets.
    Run root validation.
    Follow package boundaries.

frontend/AGENTS.md
    Never commit secrets.
    Run root validation.
    Follow package boundaries.
    Run bun test.

backend/AGENTS.md
    Never commit secrets.
    Run root validation.
    Follow package boundaries.
    Run pytest.
```

Better:

```text
/AGENTS.md
    Never commit secrets.
    Run relevant validation.
    Follow package boundaries.

frontend/AGENTS.md
    Run bun test.

backend/AGENTS.md
    Run uv run pytest.
```

Do not deduplicate something if removing it would make a subtle local override unclear.

---

# 9. Cross-Scope Changes

A coding task may touch multiple instruction scopes.

For example:

```text
backend/src/api.py
frontend/src/api.ts
packages/shared/schema.ts
```

For each modified path, calculate applicable instructions independently.

Conceptually:

```text
backend change
= root + backend rules

frontend change
= root + frontend rules

shared package change
= root + packages + shared rules
```

The final validation workflow should cover all affected scopes.

Do not assume satisfying one child's checks is sufficient for a cross-package change.

---

# 10. Generate the Root AGENTS.md

Use only sections that provide real value.

A good general structure is:

```md
# Repository Guide

## Project

Very short description.

## Repository Structure

Major architectural areas and responsibilities only.

## Development

Common repository-level development commands.

## Architecture

Important global boundaries and dependency rules.

## Coding Conventions

Only repository-specific global conventions.

## Testing

Global testing expectations.

## Repository Constraints

Important things agents must preserve or avoid.

## Change Workflow

Checks required before completing work.

## Documentation

Pointers to deeper documentation.
```

Do not include empty sections.

---

# 11. Generate Nested AGENTS.md Files

Nested files may use a simpler structure:

```md
# Backend Guide

This file contains backend-specific guidance in addition to the repository-level `AGENTS.md`.

## Development

...

## Architecture

...

## Conventions

...

## Testing

...

## Constraints

...
```

Only include sections needed by that subtree.

A nested file does not need to repeat a complete repository overview.

---

# 12. Writing Style

Write instructions for a coding agent, not prose for a human onboarding guide.

Prefer concise, direct statements.

Good:

```md
- Keep route handlers thin; application logic belongs in `src/services/`.
- Use `uv run pytest tests/foo/test_bar.py` for targeted iteration.
- Do not manually edit files under `src/generated/`.
```

Bad:

```md
- Developers should generally strive to maintain a clean separation of concerns whenever possible.
```

Prefer:

```text
imperative
specific
repository-aware
actionable
short
```

Avoid:

```text
generic
philosophical
verbose
obvious
duplicative
```

---

# 13. Commands Must Be Exact

Do not write vague commands such as:

```md
- Run the tests.
- Run linting.
```

Prefer exact commands:

```md
- Tests: `uv run pytest`
- Lint: `uv run ruff check .`
- Typecheck: `uv run pyright`
```

For monorepos, include working-directory context when necessary.

Example:

```md
From `frontend/`:

- Install: `bun install`
- Test: `bun test`
- Typecheck: `bun run typecheck`
```

Do not invent scripts.

---

# 14. Verify Commands

After drafting the instruction hierarchy, verify commands where safe and practical.

Potential examples:

```bash
uv sync
uv run pytest
uv run ruff check .
uv run pyright

bun install
bun test
bun run lint
bun run typecheck

pnpm test
pnpm lint

cargo test
cargo clippy

go test ./...
```

Use repository-specific commands rather than these examples blindly.

---

## 14.1 Verification Safety

Do not execute commands that:

- deploy,
- publish,
- release,
- push,
- modify production infrastructure,
- destroy data,
- reset databases,
- rotate credentials,
- perform destructive migrations,
- trigger external billing,
- make irreversible external changes.

Do not expose secrets.

If verification requires unavailable:

- credentials,
- network services,
- databases,
- containers,
- external APIs,
- private registries,
- hardware,
- platform-specific tooling,

record the limitation.

---

## 14.2 Interpret Failures Correctly

A command failing does not automatically mean the command is incorrect.

Distinguish between:

### Invalid instruction

Example:

```text
command does not exist
```

Fix the instruction.

### Valid command, repository currently failing

Example:

```text
tests execute correctly but three existing tests fail
```

Keep the valid command and report the existing failures.

Do not modify unrelated application behavior merely to make validation green.

---

# 15. Testing Guidance

Determine how tests are actually organized.

Document useful information such as:

- test directories,
- targeted test syntax,
- package-specific tests,
- unit vs integration separation,
- required test additions,
- important fixtures,
- expensive test suites,
- environment requirements.

Avoid generic statements like:

```md
Write good tests.
```

Prefer:

```md
- Add unit tests under `tests/unit/` for new service behavior.
- Use `uv run pytest tests/unit/test_foo.py -k case_name` for targeted iteration.
- Integration tests under `tests/integration/` require PostgreSQL.
```

Only include verified repository-specific details.

---

# 16. Architecture Guidance

Architecture instructions should answer questions such as:

```text
Where does new business logic belong?

Where should persistence logic live?

What may depend on what?

Which package owns this abstraction?

What should API handlers do?

What should UI components not do?

Where do integrations live?
```

Do not merely describe folders.

Bad:

```md
- `services/` contains services.
```

Good:

```md
- Application/business logic belongs in `services/`; route handlers should handle transport concerns and delegate to services.
```

---

# 17. Generated Files and Code Generation

Identify generated areas.

For each generated area, determine:

- whether manual edits are prohibited,
- what generates it,
- which source file should be changed instead,
- which generation command should be run.

Example:

```md
- Do not manually edit `src/generated/`.
- Update `schemas/api.yaml`, then run `bun run generate`.
```

Do not label files generated unless evidence confirms this.

---

# 18. Documentation as Progressive Disclosure

When detailed documentation already exists, point to it.

Example:

```md
## Documentation

- Architecture decisions: `docs/ARCHITECTURE.md`
- Testing setup: `docs/TESTING.md`
- UI principles: `DESIGN.md`
- Security-sensitive workflows: `docs/SECURITY.md`
```

Do not copy large portions into `AGENTS.md`.

The instruction file should tell the agent **when** to read the deeper document.

Even better:

```md
- Read `docs/ARCHITECTURE.md` before changing package boundaries.
- Read `DESIGN.md` before introducing new UI primitives.
```

---

# 19. Prefer Mechanical Enforcement

During analysis, identify important rules that would be better enforced automatically.

Examples:

```text
Domain cannot import persistence.

Frontend packages cannot import desktop internals.

Generated code must remain unchanged.

Formatting must pass before merge.
```

Possible enforcement mechanisms include:

- lint rules,
- architecture tests,
- dependency-boundary checks,
- type checking,
- CI checks,
- pre-commit hooks,
- generated-file checks.

Do not build new enforcement infrastructure unless explicitly required by the task.

However, report strong candidates for mechanical enforcement in the final summary.

A rule enforced by tooling does not necessarily need extensive explanation in `AGENTS.md`.

---

# 20. Detect Documentation Drift

Compare important documentation against executable repository behavior.

Look for discrepancies such as:

```text
README says npm
repository uses pnpm

README says Python 3.11
pyproject requires >=3.13

CONTRIBUTING says pytest
CI uses uv run pytest

architecture docs describe a directory that no longer exists
```

Do not automatically rewrite unrelated documentation unless necessary for this task.

Report meaningful drift in the final response.

If a stale document would cause agents to make incorrect changes, consider correcting it only when clearly appropriate and within scope.

---

# 21. Avoid Staleness-Prone Content

Do not put frequently changing facts into `AGENTS.md` unless operationally necessary.

Usually avoid:

- exact dependency versions,
- exact file counts,
- exact test counts,
- contributor names,
- temporary roadmap status,
- generated tree dumps,
- current branch names,
- transient feature status.

Prefer durable rules and navigation.

---

# 22. AGENTS.md Quality Gate

After drafting all files, review every meaningful instruction.

For each statement, ask:

> What repository evidence supports this?

If no meaningful evidence exists:

- remove it,
- weaken it,
- or explicitly mark it as an inference if truly necessary.

Then evaluate the hierarchy for:

### Accuracy

- Are commands real?
- Are paths correct?
- Are architecture statements correct?
- Are package-manager assumptions correct?

### Scope

- Is each instruction stored at the appropriate level?
- Are global instructions actually global?
- Are local instructions narrow enough?

### Duplication

- Are child files unnecessarily repeating parents?

### Conflicts

- Are parent/child contradictions intentional?
- Is precedence clear?

### Signal-to-noise

- Would a coding agent benefit from every section?

### Staleness

- Is any information likely to become wrong quickly?

### Discoverability

- Can an agent quickly find deeper documentation?

---

# 23. Fresh-Agent Usability Test

Evaluate the resulting repository as if you were a coding agent entering it for the first time.

Using the repository plus applicable `AGENTS.md` instructions, verify that you can answer:

1. What does this repository contain?
2. Which subproject should I work in?
3. How do I install dependencies?
4. How do I start development?
5. How do I run the relevant tests?
6. How do I run a targeted test?
7. How do I lint?
8. How do I format?
9. How do I typecheck?
10. How do I build?
11. Where does business/application logic belong?
12. Where does persistence logic belong?
13. Which architectural dependency directions must I preserve?
14. Which generated files should I avoid editing?
15. Which other files or directories require special care?
16. What checks should I run before finishing?
17. Which deeper documentation should I consult for my task?
18. Which instructions apply to the specific subtree I am editing?

If an important answer requires repeated repository archaeology, add concise guidance.

If information is trivial to discover and rarely needed, do not add it.

---

# 24. Simulate Scope Resolution

For repositories with multiple `AGENTS.md` files, test several representative paths.

Example:

```text
backend/src/foo.py

Applicable:
- /AGENTS.md
- /backend/AGENTS.md
```

Example:

```text
packages/auth/src/token.ts

Applicable:
- /AGENTS.md
- /packages/AGENTS.md
- /packages/auth/AGENTS.md
```

Verify:

- no important rule is lost,
- no unnecessary duplication exists,
- intentional overrides make sense,
- effective instructions are not contradictory.

---

# 25. Cross-Package Validation

If different parts of the repository have separate validation commands, make this clear.

For example:

```text
Backend change:
    uv run pytest
    uv run ruff check .

Frontend change:
    bun test
    bun run typecheck

Rust desktop change:
    cargo test
    cargo clippy
```

For cross-package changes, require all relevant checks.

Do not imply that running only root checks is enough unless the root command actually covers all affected projects.

---

# 26. What NOT to Put in AGENTS.md

Avoid sections containing generic information like:

```md
## Best Practices

- Keep functions small.
- Write clean code.
- Avoid duplication.
- Use descriptive names.
- Follow SOLID.
- Handle errors properly.
```

Avoid giant dependency dumps:

```md
## Dependencies

- React
- TypeScript
- Zustand
- TanStack Query
- ...
```

unless a dependency implies a specific repository convention an agent must follow.

Avoid giant directory dumps.

Avoid explaining technologies generically.

Avoid restating the README.

Avoid describing obvious syntax.

Avoid speculative architecture.

Avoid rules based on personal preference rather than repository evidence.

---

# 27. Safety and Scope

Do not make unrelated application changes.

Do not refactor source code merely to make the repository easier to describe.

Do not add dependencies unless absolutely necessary.

Do not expose secrets.

Do not print secret values discovered in environment files.

Do not copy `.env` contents into documentation.

Do not execute destructive commands.

Do not deploy.

Do not release.

Do not publish.

Do not push commits unless explicitly requested.

Do not change application behavior unless required to correct something directly necessary for this task.

---

# 28. Expected Repository Shape

A simple repository may end with:

```text
AGENTS.md
```

A larger repository may end with:

```text
AGENTS.md

backend/
└── AGENTS.md

frontend/
└── AGENTS.md

desktop/
└── AGENTS.md
```

A complex monorepo may have:

```text
AGENTS.md

apps/
├── AGENTS.md
├── web/
│   └── AGENTS.md
└── api/
    └── AGENTS.md

packages/
├── AGENTS.md
├── auth/
│   └── AGENTS.md
└── database/
    └── AGENTS.md
```

Do not create nested files merely to mirror directories.

Every nested file must have a meaningful reason to exist.

---

# 29. Final Review Checklist

Before finishing, verify all of the following:

- [ ] All existing `AGENTS.md` files were discovered before editing.
- [ ] Existing instruction hierarchy was understood.
- [ ] Repository tooling was inspected before generation.
- [ ] CI/build configuration was treated as stronger evidence than prose documentation.
- [ ] Major languages and package managers were correctly identified.
- [ ] Development commands are real.
- [ ] Validation commands are real.
- [ ] Commands were executed where safe and practical.
- [ ] Command failures were correctly distinguished from invalid commands.
- [ ] No generic coding advice was added.
- [ ] No unnecessary dependency dump was added.
- [ ] No full repository tree was added.
- [ ] Major architectural boundaries are explained.
- [ ] Important repository-specific constraints are documented.
- [ ] Generated areas are identified where applicable.
- [ ] Root guidance contains repository-wide rules.
- [ ] Local guidance is stored in appropriate child scopes.
- [ ] Child files primarily contain deltas from parents.
- [ ] Parent rules are not unnecessarily duplicated.
- [ ] Intentional child overrides were preserved.
- [ ] Accidental conflicts were resolved where evidence allowed.
- [ ] Cross-scope changes have clear validation expectations.
- [ ] Root `AGENTS.md` remains concise.
- [ ] Nested files remain concise.
- [ ] Detailed information points to deeper documentation.
- [ ] Existing useful human-authored instructions were preserved.
- [ ] Every important rule has repository evidence.
- [ ] Stale documentation conflicts were identified.
- [ ] Potential mechanical enforcement opportunities were identified.
- [ ] Representative paths were tested against the instruction hierarchy.
- [ ] A fresh coding agent could navigate the repository without excessive archaeology.

---

# 30. Final Response

After making the actual repository changes, provide a concise report containing:

## AGENTS.md Changes

List every `AGENTS.md` created or modified.

Example:

```text
Modified:
- /AGENTS.md
- /backend/AGENTS.md

Created:
- /frontend/AGENTS.md
```

## Repository Conventions Discovered

Summarize only the most important conventions discovered.

## Verification

Report commands successfully verified.

Example:

```text
✓ uv run ruff check .
✓ uv run pytest
✓ bun run typecheck
```

Report commands that could not be verified and why.

Example:

```text
Could not verify integration tests because PostgreSQL is not available.
```

## Conflicts or Drift

Mention:

- stale README instructions,
- conflicting existing `AGENTS.md` rules,
- outdated commands,
- unclear architectural guidance.

Only mention meaningful issues.

## Mechanical Enforcement Candidates

List important rules that appear worth enforcing through CI, linting, tests, or architecture checks.

Keep this section short.

---

# 31. Execution Requirement

Do not stop after proposing an `AGENTS.md` structure.

Do not merely explain what should be written.

Perform the task:

```text
discover
    ↓
inspect
    ↓
model repository
    ↓
understand instruction hierarchy
    ↓
identify global vs local rules
    ↓
create/update AGENTS.md files
    ↓
deduplicate
    ↓
resolve scope conflicts
    ↓
verify commands
    ↓
test instruction usability
    ↓
review
    ↓
report
```

The desired outcome is a repository whose `AGENTS.md` hierarchy provides the **minimum amount of high-confidence information necessary for a coding agent to work correctly**.

When uncertain, prefer:

```text
verified > inferred

specific > generic

operational > descriptive

constraint > trivia

short > exhaustive

reference > duplication

mechanically enforced > prose-only rule

parent default + child delta > duplicated standalone files
```
"""


_BUILTIN_COMMANDS: dict[str, Command] = {
    "init": Command(
        name="init",
        description="Create or update AGENTS.md for this project.",
        body=_BUILTIN_INIT_BODY,
        path=Path("<builtin>"),
        source="builtin",
    ),
}


def get_builtin_command(name: str) -> Command | None:
    """Return the built-in command with *name*, or ``None`` if not built-in."""
    return _BUILTIN_COMMANDS.get(name)


# ── Public API ──────────────────────────────────────────────────────────────


def discover_commands(workspace: Path | None = None) -> dict[str, Command]:
    """Return ``{name: Command}`` for every command across the four roots.

    First-source wins on conflict. ``workspace`` is exposed for tests and
    coding mode; callers pass nothing to list only global commands.
    """
    commands: dict[str, Command] = {}
    for root, source in _candidate_roots(workspace):
        for path, name in _iter_md(root):
            if name in commands:
                continue  # earlier source wins
            content = _cached_command_content(path)
            if content is None:
                continue
            description, body = content
            commands[name] = Command(
                name=name,
                description=description,
                body=body,
                path=path,
                source=source,
            )
    return commands


def render_command(command: Command, arguments: str = "") -> str:
    """Substitute ``$ARGUMENTS`` in *command.body*.

    If the placeholder is present, every occurrence is replaced. If it
    is absent and *arguments* is non-empty, the arguments are appended
    on a new line so the LLM still sees them. Empty arguments leave
    the body untouched.
    """
    args = arguments.strip()
    if "$ARGUMENTS" in command.body:
        return command.body.replace("$ARGUMENTS", args)
    if args:
        return f"{command.body}\n\n{args}"
    return command.body
