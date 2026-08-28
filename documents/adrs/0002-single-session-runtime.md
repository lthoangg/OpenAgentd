# ADR-0002: Single `SessionRuntime` Object and `/api/session/*` Wire Surface

## Status
Accepted

## Date
2026-08-28

## Context
ADR-0001 replaced the in-process member roster with one agent per session and
git-worktree isolation. The runtime code kept the shape of the old model:

- `AgentTeam` held a `lead` plus a `members` dict, `blueprints`, `all_members`,
  and `status()` — all permanently empty or single-element after ADR-0001.
- `TeamMemberBase` existed only to be subclassed by `TeamLead`, with six
  override seams (`_on_wake`, `_on_turn_success`, `_on_turn_finally`,
  `_role_label`, `_skip_inbox_persistence`, `_should_emit_inbox_sse`) that had
  exactly one implementation each.
- `AgentTeam` and `TeamLead` are created together, live together, and die
  together, yet reach into each other's private state in both directions
  (`self._team._emit(...)`, `self._team._try_emit_done()`, `team.lead._llm_history`,
  `team.lead._cancel_event`). Invariants for one turn are therefore split
  across two objects.
- The HTTP surface (`/api/team/*`) and the frontend client, query keys, and
  stores all carry "team" naming for what is now a single-agent session.

The naming actively misleads: a reader (human or agent) reasonably assumes a
roster of concurrently running agents exists, and defensive code keeps getting
written for a multi-member case that cannot occur.

## Decision
Collapse the runtime into a single `SessionRuntime` object that owns one
session's agent, inbox, turn execution, commands, and stream lifecycle, and
rename the HTTP surface from `/api/team/*` to `/api/session/*` outright,
migrating the frontend in the same change. Flatten the roster-shaped response
bodies in the same release, since both are breaking and the client ships with
the server.

## Alternatives Considered

### Keep `AgentTeam` + `TeamLead`, fix only the seam
- Pros: smallest diff; no test churn; no client impact.
- Cons: preserves two objects with a 1:1 lifetime and mutual private access;
  every future turn-lifecycle invariant still has to be reasoned about twice.
- Rejected because: the split, not the naming, is what makes the lifecycle hard
  to follow.

### Rename modules and classes without merging
- Pros: honest names; mechanical, low-risk.
- Cons: leaves the coupling untouched — a cosmetic fix to a structural problem.
- Rejected because: it spends a large diff without removing any complexity.

### Keep `/api/team/*` and rename internals only
- Pros: no breaking change; desktop shells and browser clients keep working
  across versions.
- Cons: permanent inconsistency at the boundary; every new contributor learns
  two vocabularies for one concept, and the frontend keeps team-shaped query
  keys and store names.
- Rejected because: OpenAgentd ships its client and server together, so the
  compatibility window buys little and the mixed vocabulary is long-lived.

### Rename the wire behind a compatibility alias
- Pros: no hard break; allows a staged frontend migration.
- Cons: two routers to maintain, duplicated auth/validation paths, and a
  deprecation that in practice never gets removed.
- Rejected because: client and server are versioned and released together.

## Consequences

### Positive
- One object, one lifetime, one place where turn state, cancellation, question
  suspension, and `done` emission are reasoned about.
- Deletes the roster surface (`members`, `blueprints`, `all_members`,
  `status()`), the abstract base class, and its single-implementation hooks.
- Response bodies describe one session: `GET /api/session/{id}/history` returns
  a single `session` object (was `lead` plus an always-empty `members: []`, and
  `TeamHistoryMember` is deleted), and `GET /api/session/agents` drops
  `is_lead` and `blueprints: []` while adding a `children` array for spawned
  child sessions. The frontend's member hydration, reconciliation, and
  pagination paths in `stores/useTeamStore/session-slice.ts` are gone with it.
- Backend, HTTP surface, and frontend share one vocabulary: session.

### Trade-offs & Discipline
- **Breaking API change.** `/api/session/*` replaces `/api/team/*`; the desktop
  shells and web client must ship in the same release. Older clients break by
  design rather than silently degrading. The same applies to the flattened
  response bodies above: there is no compatibility alias for either.
- `SessionRuntime` concentrates behavior that was previously split. It must be
  kept decomposed by concern (turn execution, commands, stream lifecycle)
  rather than growing into an unstructured god object.
- Test doubles that previously stubbed `team.lead` now stub the runtime
  directly; mocks that set roster attributes are removed.

### Deliberate Follow-up Debt
Renaming these in the same change would either break an external contract or
balloon an already-large diff, so they were left as-is on purpose:

- **Module paths.** The runtime still lives under `app/agent/mode/team/`, and
  the routers under `app/api/routes/team/`. Directory renames touch every
  import and every patch target in tests, with no behavioural gain.
- **Service function names.** `get_or_start_coding_team`,
  `find_live_team_serving_session`, `interrupt_team`, and `set_team` keep their
  names, as does the internal `TeamDiff.lead` field (a service-layer dataclass,
  not a wire body).
- **Hook names.** `TeamInboxHook` and `app/agent/mode/team/hooks/team_inbox.py`
  keep team naming even though the class it serves is `SessionRuntime`.
- **`state.metadata["lead_session_id"]`** and the `OpenTelemetryHook(
  lead_session_id=...)` kwarg. Tools read that metadata key and the value lands
  in span attributes, so renaming it is a telemetry-schema change that would
  break saved queries and dashboards.
- **`state.metadata["team_workspace"]`**, read by
  `app/agent/agent_loop/tool_executor.py`. Same reasoning as above.
- **`team_*` log keys outside `SessionRuntime`** (`team_manager_*`,
  `team_interrupt*`). They name modules and functions that keep their names, so
  renaming only the keys would be the inconsistent half of a rename. Keys
  emitted by the runtime itself *were* renamed to `session_runtime_*`, because
  the old `team_member_*` / `team_lead_*` prefixes named objects that no longer
  exist. Log-based alerts on those keys need updating.
- **`set_role("lead")`.** This token drives `applies_to` filtering in
  *user-authored* plugins. Changing it silently stops their filters matching.
- **Frontend `team` identifiers.** `useTeamStore`, `api/client/team.ts`, and
  the `['team', ...]` TanStack query keys are internal names, not URL segments,
  and were intentionally excluded from the wire rename.
- **Multi-stream store shape.** `agentStreams` stays a name-keyed map with a
  `lead` entry rather than collapsing to a single stream object. Historical
  pre-collapse sessions still replay SSE events for other agent names, so the
  map is what keeps those transcripts readable.

Each is a mechanical rename that can be done independently; none of them
affect the single-runtime invariants this ADR is about.

## References
- ADR-0001: `documents/adrs/0001-session-per-agent-worktrees.md`
