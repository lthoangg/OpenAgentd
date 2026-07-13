---
title: Lazy team members & dynamic instances
description: Lead-driven spawn/dismiss of member agents, blueprint#N handles, history restore, and design caveats.
status: stable
updated: 2026-05-19
---

# Lazy team members & dynamic instances

Members no longer exist at startup. Each configured `*.md` file in
`OPENAGENTD_CONFIG_DIR/agents/` whose `role: member` and `model:` is a real
`provider:model` value becomes a **blueprint** on the team. Seed placeholders
(`__PROVIDER_MODEL__`), blank models, and missing models are skipped so a
fresh install does not expose members that cannot run. The lead spawns
instances on demand via `team_manage`, addresses them by handle
(`blueprint#1`, `blueprint#2`, …), and explicitly retires them with
`team_manage(action="dismiss", ...)`.

## Why

- Avoid building member agents that may never be used in a session.
- Allow multiple parallel instances per blueprint (e.g. two `executor`s in
  flight at once).
- Keep history retrievable: dismissing only removes the in-memory `TeamMember`,
  the DB `ChatSession` row stays put and gets re-attached when the same
  handle is spawned again.

## Lifecycle

```
load_team_from_dir()
    └── lead built eagerly
    └── members → MemberBlueprint registered on team

lead's first turn
    └── team_manage(action="spawn", members=["executor"])        # → executor#1
    └── team_message(to=["executor#1"], ...)
    └── team_manage(action="spawn", members=["executor"])        # → executor#2
    └── team_manage(action="dismiss", members=["executor#1"])
    └── team_manage(action="spawn", members=["executor#1"])      # restores executor#1 history
```

`AgentTeam.spawn()` is the low-level entry point; the lead-facing roster tool
is `team_manage(action="list"|"spawn"|"dismiss", members=[...])`.

### Counter rules

`MemberBlueprint.next_instance_id` is the auto-assignment cursor. It is
**lazily reconciled per lead session** by scanning the DB for any
`agent_name = 'blueprint#N'` rows whose `parent_session_id` is the current
lead session, then setting the cursor to `max(N) + 1`. Reconciliation runs
once per `(blueprint, lead_session)` pair (`bp.counter_reconciled_for`).

- Restart-safe: a new process picks up where the prior one left off.
- New lead session resets the cursor scope: `is_new_session=True` in
  `handle_user_message` clears `counter_reconciled_for`, so the next spawn
  reconciles afresh against the new lead session id.
- Legacy bare-name rows (`agent_name = 'executor'`) are **not** counted —
  see "Legacy adoption" below.

### Legacy adoption (one-shot)

Older sessions persisted member rows under the bare blueprint name
(`executor` rather than `executor#1`). On the first `team_manage(..., ["executor"])`
under the current lead session, `_resolve_session_for_handle` looks for such
a row and, if found, rewrites its `agent_name` to `executor#1`. The instance
is then claimed as `#1`. This happens at most once per blueprint per lead
session. After adoption the row is indistinguishable from a natively-spawned
`#1`.

### Recipient resolution

`team_message(to=...)` accepts:

| input            | resolves to                                                   |
|------------------|---------------------------------------------------------------|
| `lead`           | the lead                                                      |
| `executor#2`     | the live `executor#2`, or an error if not spawned             |
| `executor`       | the only live `executor#N` if exactly one; otherwise an error |

The bare-blueprint shorthand is a convenience for the common single-instance
case. With zero live instances the lead is told to `team_manage(action="spawn")` first; with
two or more, it must disambiguate by handle.

### What agents see

Team protocol prompts are cache-stable and do not embed the dynamic roster.
The lead discovers current live handles and spawnable blueprints with
`team_manage(action="list", members=[])`. Members receive their exact runtime
identity (`blueprint#N`) and mailbox messages from the lead or active peers;
spawning remains a lead-only concern.

### Tool surface

| tool          | available to | purpose                                       |
|---------------|--------------|-----------------------------------------------|
| `team_message`| lead, members| send a message to a specific recipient        |
| `team_manage` | lead         | list, spawn, or dismiss roster instances       |

These are injected at `agent.run()` time by `AgentTeam.get_injected_tools`.
Roster changes are returned by the tool and persisted as append-only system
messages, so spawning a peer does not require a system-prompt cache bust.

## Caveats

- **No auto-dismiss.** If the lead forgets to dismiss via `team_manage`, instances
  stay live for the duration of the lead session. Activation cost is zero
  while idle (mailbox-driven), so this is a hygiene issue rather than a
  resource leak. Consider documenting it in `LEAD_PROTOCOL` if real lead
  prompts drift toward never dismissing.
- **History grows linearly with `#N`.** Each unique handle gets its own
  `ChatSession` row + message history. A lead that auto-spawns dozens of
  short-lived instances will accumulate rows. There is no built-in trim;
  rely on session-level archival.
- **Counter is per-lead-session.** Two different lead sessions can each
  have an `executor#1`, parented under different lead UUIDs. They are
  distinct DB rows. This is intentional (history is scoped to the lead
  session that owned the instance) but means handles aren't globally
  unique — only `(lead_session_id, handle)` is.
- **Eager-members back-compat path is still in `AgentTeam.__init__`.**
  Tests and a few direct callers still construct teams with
  `members={"name": TeamMember(...)}`. These plain members survive lead
  session changes and remain addressable through roster discovery. Production
  code paths use `blueprints=`. If we eventually drop
  the eager path, simplify `_restore_or_drop_members_for_lead` and the
  protocol assembly.
- **Mid-turn parenting.** When the lead spawns mid-turn, the new member's
  DB row needs `parent_session_id = lead_session_id` immediately so that
  `_resolve_session_for_handle` can find it on a later restore. The fix
  is `_parent_member_session()` called right after `_ensure_db_session()`
  inside `_spawn_locked`. Don't rely on `handle_user_message`'s parenting
  block — that runs only on the next user turn.
- **Tool object is callable, not `tool.fn`.** `Tool.__call__` dispatches
  to the wrapped function. Tests should call `tool(args)` directly; there
  is no `tool.fn` attribute.
- **Frontend roster display.** `/team/agents` exposes `blueprints` with
  `live_instances`; the web UI lists them in the agent capabilities drawer.
  Split view follows agent status: spawned/live members appear automatically,
  and dismissed members close when they become `offline`. Historical members
  missing from the live roster stay `offline` after session reload.

## Alternative designs considered

1. **Eager members, no instances.**
   Original behaviour. Simple but blocks the parallel-`executor` use case
   and forces the lead to either round-robin a single inbox or fan tasks
   out via subprocess hacks. Rejected.

2. **Instances as siblings, no blueprints.**
   Generate `executor#N` agents at load and treat them as a fixed pool of
   plain members. Wastes resources (most pool slots idle) and leaks pool
   sizing into config. Rejected.

3. **Auto-dismiss when a member finishes a turn.**
   Tempting because it keeps the live roster small, but breaks
   long-running consultative members (e.g. a `reviewer` that the lead
   queries multiple times across a turn). Rejected in favour of an
   explicit `team_manage(action="dismiss")` call. Could be added later as an opt-in
   blueprint flag (`auto_dismiss: true`).

4. **Counter scoped globally.**
   Use a single autoincrement per blueprint regardless of lead session.
   Cleaner numbering but couples unrelated lead sessions and creates
   restore ambiguity (which lead does `executor#42` belong to?). Rejected
   in favour of `(lead_session, blueprint)` scoping.

5. **Always auto-suffix, no bare-name shorthand.**
   Force the lead to always type the full `blueprint#N`. Removes the
   ambiguous-shorthand error path but trades that for prompt verbosity
   in the common single-instance case. Kept as a fallback if real prompts
   show shorthand abuse.

6. **Hide blueprints; only expose `team_manage(role=...)`.**
   Treat blueprint name as opaque metadata. Simpler tool surface but
   loses the descriptive "executor / reviewer / planner" vocabulary the
   lead can pattern-match on. Rejected.

## Files of interest

| concern                              | file                                                |
|--------------------------------------|------------------------------------------------------|
| blueprint definition + parsing       | `app/agent/loader.py`                                |
| `MemberBlueprint`, spawn / dismiss   | `app/agent/mode/team/team.py`                        |
| runtime blueprint rediscovery        | `app/services/team_manager.py:refresh_blueprints`    |
| roster tools                         | `app/agent/mode/team/manage.py`                      |
| protocol prompt assembly             | `app/agent/mode/team/member.py`                      |
| recipient resolution                 | `app/agent/mode/team/tools.py`                       |
| `/team/agents` API surface           | `app/api/routes/team/chat.py`                        |
| spawn/dismiss test coverage          | `tests/agent/mode/team/test_team_spawn.py`           |
| loader behaviour                     | `tests/agent/test_loader.py`                         |
