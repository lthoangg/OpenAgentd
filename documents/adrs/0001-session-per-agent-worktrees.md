# ADR-0001: Session-per-Agent Model with Git Worktree Isolation

## Status
Accepted

## Date
2026-08-27

## Context
The legacy multi-agent architecture in OpenAgentd executed multiple member instances (instantiated from Markdown blueprint files) inside a single runtime process. All members shared a single workspace filesystem, a single multiplexed SSE event stream, and an in-memory mailbox system.

This model presented several critical limitations:
1. **Concurrent File Collisions**: When multiple agents edited files in the shared workspace concurrently, they raced and clobbered each other's edits, leaving the user's working copy in an inconsistent state.
2. **Stream Multiplexing Complexity**: The single SSE stream multiplexed output from multiple agents on the lead session ID, requiring extensive frontend demultiplexing, custom split grids, and brittle turn synchronization.
3. **In-Memory Mailbox Fragility**: Mailbox messages did not survive daemon restarts or idle team evictions, relying on side-channel task board reconciliations to rewake agents.
4. **Roster Maintenance Overhead**: Blueprint loading, dynamic member numbering, re-parenting of sub-sessions, and dual lead/member lifecycle states introduced substantial cognitive and runtime complexity.

We need an architecture that ensures strict filesystem isolation between concurrent agents, simplifies the streaming and frontend architecture, provides durable cross-agent communication, and integrates cleanly with standard session management.

## Decision
Replace the in-process blueprint roster with a **session-per-agent** model with **git worktree isolation**:

1. **Single Agent Definition**: Maintain exactly one predefined agent (`openagentd`). Eliminate member blueprints, rosters, and `team_manage`.
2. **Worktree Isolation**: When delegation occurs, spawn an independent `ChatSession` with its own isolated git worktree and branch created from the parent workspace. Workspaces that are not git repositories refuse delegation with an instructive error.
3. **Server-Side Merge Tool (`agent_merge`)**: The child agent executes within its worktree sandbox. To merge its work back into the parent workspace, it calls a dedicated `agent_merge` tool that safely validates preconditions (clean worktree, clean parent working copy, non-fast-forward merge) and executes argument-list git operations in the parent repository. If conflicts arise, it cleanly aborts without modifying the parent tree. On clean merge, the temporary worktree and branch are automatically cleaned up.
4. **Asynchronous & Durable Report Delivery**: When a child session finishes, its final response is delivered asynchronously to the parent session. Delivery prioritizes the parent's live mailbox if idle or mid-turn, and falls back to a persisted queued-messages queue if the parent is busy, offline, or pending user input, ensuring reports survive daemon restarts.
5. **Standard Sessions**: Child sessions are first-class sessions accessible directly in the sidebar under their worktree node.

## Alternatives Considered

### 1. In-Process Roster with Shared Workspace
- **Pros**: Low overhead; fast in-memory communication; no git dependency.
- **Cons**: Severe race conditions when concurrent agents edit the same repository; complex stream demultiplexing; fragile state management across restarts.
- **Rejected because**: Concurrent unisolated edits in a single workspace are fundamentally unsafe.

### 2. Sub-Sessions Sharing a Single Workspace
- **Pros**: Independent session IDs and distinct conversation histories without git worktree management.
- **Cons**: Does not solve the core issue of concurrent file conflicts; both agents still mutate the same directory simultaneously.
- **Rejected because**: Filesystem isolation is a mandatory requirement for autonomous parallel agents.

### 3. Prompt-Protocol Merge via Shell (Raw Git Commands)
- **Pros**: Avoids implementing a specialized server-side merge tool.
- **Cons**: The child agent is sandboxed to its worktree directory. Enabling it to run raw git merge commands inside the parent repository would require bypassing or widening the security sandbox (a security regression). Furthermore, error recovery (such as aborting failed merges) would depend entirely on model compliance rather than deterministic server-side guards.
- **Rejected because**: Violates sandbox security boundaries and introduces risk of corrupting the user's live working tree.

## Consequences

### Positive
- **Safety**: Concurrent agents work on isolated branches and worktrees with zero chance of file clobbering.
- **Simplicity**: Eliminates stream multiplexing, `SplitGrid` UI, blueprint parsing, member re-parenting loops, and roster synchronization. Every session has exactly one SSE stream and one agent instance.
- **Observability**: Child sessions are standard sessions visible in the sidebar, inspectable, and interactive.
- **Durability**: Cross-agent messages leverage the persisted message queue fallback, surviving daemon restarts.

### Trade-offs & Discipline
- **Git Dependency**: Spawning sub-agents requires the workspace to be a valid git repository.
- **Worktree Lifecycle**: Temporary worktrees must be cleaned up on clean merge or aged out via artifact cleanup for abandoned sessions.
- **Caps**: Concurrency (max 5 running children per parent) and recursion depth (max depth 2) must be strictly enforced.

## References
- ADR-0002: `documents/adrs/0002-single-session-runtime.md`
