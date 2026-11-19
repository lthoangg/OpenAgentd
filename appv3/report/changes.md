# Wire and on-disk changes by release

Part of the compatibility log. [`REPORT.md`](../REPORT.md) is its index and keeps the section numbers.

## A script call says what its closed row shows (v3.62.0)

A `script` call's output stays on the server like most tools' (`result`
null, `result_omitted`, `result_bytes`). Where those are sent, a finished
run now also carries `script_run: {"calls": <int>, "saved"?: <name>,
"stopped"?: true}`: every call the script made, the name it was saved
under, and whether the time limit ended it. It is in the `metadata` of the
`tool_end` event (live and replayed on attach) and on the tool row of
session history, beside `result_bytes`. It is read from the result's own
text (`appv3_db::api::script_run`); a call that never ran (an argument
error, `list`) has none. Older clients ignore the field; a client that
meets an older server shows the count once the row is opened, as before.

## The worktree list follows git and the disk (v3.58.0)

`GET /api/agent/workspace/tree` now reconciles each repository before it
answers: a `worktree` or `folder` row whose folder is gone gets
`deleted_at` set (only while the repository's own folder is reachable), and
checkouts `git worktree list` shows with no row are listed without being
stored. Each item of `repositories[].worktrees` gains `external` (bool: a
worktree OpenAgentd did not make), and each repository gains
`former_checkouts: [{path, name}]` (deleted worktree/folder rows that still
hold top-level sessions). `missing` stays, now only for checkouts of a
repository that can't be reached. Older clients ignore the new fields.

`DELETE /api/agent/sessions/{id}?remove_worktree=true` (new query flag)
answers `200 {"deleted": true, "worktree": null | {"name", "removed",
"reason"?}}` instead of `204`: an OpenAgentd worktree the session ran in is
removed once no session or scheduled task uses it and it has no uncommitted
change and no commit that only its branch holds. Without the flag the
route is unchanged.

Hide (`PATCH /workspace/visibility`), rename and remove
(`/workspace/worktrees`) file a path with no row by git first, so they no
longer store `worktree` rows without a `source_path`. `agentd cleanup
--apply` removes old managed worktrees with `git worktree remove` and
`prune`, marks their rows deleted, and skips any with uncommitted changes.

## Phone pushes wait for an unseen notification (v3.58.0)

`POST /api/agent/{session_id}/seen` (new; body ignored; `{"status": "ok"}`,
422 for an id that is not a UUID) tells the server a client shows the
session in a focused window. Answering a question counts as seen too. The
server keeps the time in memory only, nothing on disk.

A letter for the account's phones (`cloud/letters.rs`) is no longer sent at
once: it waits 60 s and is dropped when its session was seen after it was
raised (a report up to 2 s before still counts: the two can cross). A
letter with no session always goes. Held letters go out at once when the
host's cloud task ends normally. The cloud API and the sealed letter format
are unchanged.

## `script` tool (v3.57.0)

Every agent, lead and member, is offered a new built-in tool, `script`
(`crates/tools/data/tool_definitions.json`). An agent file's `tools:` list
cannot remove it, so the tools block of every model request grows by about
2.9k characters.

A script's nested tool calls publish no tool events and store no rows of
their own: the transcript holds one `script` call and one result. The web
client reads that result as text
(`web/src/components/ToolCall/scriptTrace.ts`), so its lines are a wire
format:

- `calls (<count>, <seconds> s):`, then one line per nested call, at most
  30, then `… <n> more`: `→ <tool> <target> · <ms> ms · <size>`, or
  `· error: <message>` for a failed call, or `· cancelled` for one the
  script's end cut off.
- `output:`, then what the script logged and the value it returned, or
  `(nothing logged or returned)`; `[output cut at 50000 characters: log
  less]` when it was cut.
- `error: <message>` when the script failed or reached its 270 s limit.
- `saved as <name> (<path>)` when `save_as` stored it.

While a script runs, its live output has one line per event: `▸ <n> <tool>
<target>` when a nested call starts, then `✓ <n> <ms> ms · <size>` or `✗ <n>
error: <message>`.

On disk, `save_as` writes `<workspace>/.agents/scripts/<name>.ts` in a coding
workspace and `<config>/scripts/<name>.ts` otherwise, and removes a
`<name>.js` beside it. `name` looks in the workspace folder first.

## Account names, recovery code and departed devices (v3.56.0)

All of these are local-only routes unless said otherwise (an unproxied
loopback caller on the private listener), like the rest of `/api/cloud/*`.

- **Device names.** `GET /api/cloud/devices` rows gain `name: string | null`,
  the name the account keeps for the device (cleaned as it is read: one
  line, at most 40 characters). Devices the cloud lists as departed (left,
  or removed) are no longer listed; a device the cloud does not list at all
  stays. `POST /api/cloud/devices/name` `{ "device_id": string, "name":
  string | null }` (an empty or blank name is `null`) answers `{ "device_id",
  "name" }` with the stored name. A device may always name itself; naming
  another needs this computer to approve devices. Naming this computer also
  sets its server name (`computer_name`; `null` gives it the host name back).
  No roster is written and no approval proof is asked. Errors (`detail`):
  403 `Only a device that approves others can rename this device.`, 409
  `That device is no longer in your account.`, 429 `Too many renames. Try
  again in a few minutes.`, 400 `Use 1 to 40 characters, on one line.`, 400
  `Malformed request.` for an id that is not a device id.
- **Name sync.** A signed-in computer keeps its server name and the
  account's name for it the same: `PUT /api/server/name` also pushes the new
  name to the account in the background (the response never waits for the
  cloud), and each check-in with the cloud (at most once a minute) merges
  three values with `name_synced`, the name both last agreed on, now stored
  in `<state>/cloud/identity.json`: never agreed, the account's name wins,
  else this computer's is pushed; agreed before, a change made here is
  pushed, else a change made in the account is taken here (no name there:
  the host name again). A computer so names itself right after it joins.
  The cloud now receives the server name (it used to stay on the computer).
- **Departed devices.** At each check-in a computer that approves devices
  writes the roster without the devices that left or were removed, with no
  prompt (it grants nothing): `cloud_departed_dropped version=…` in the log,
  tried again at the next check-in on failure. Every roster a signer route
  here writes (approve, add by invitation, remove) leaves them out too.
- **Recovery code.** `POST /api/cloud/recover` `{ "code": string, "server"?:
  bool, "client"?: bool }` (roles default to both, like `/login`) signs this
  computer in with a browser code only (no scan code) and, once the person
  approves it, rewrites the roster with this computer alone, as a device
  that approves; every other device is signed out and the recovery code stays
  valid. The status answers `signing_in` with `recovering: true` (omitted
  otherwise). 400 `That is not a recovery code. Check it and type it again.`
  for a code of the wrong shape (checked before any sign-in; the code is
  never logged). A code that is not the account's ends in guest with the new
  notice `wrong_recovery_code`, nothing changed. An account with no devices
  goes on to `recovery` (create it), as `/login` does. `GET
  /api/cloud/status` `connected` gains `recovered: true` (omitted otherwise)
  from the recovery until `POST /api/cloud/recovered/ack` (answers the
  status) or a restart. `agentd cloud recover` does the same from a terminal.
- **Letting a device approve.** `POST /api/cloud/devices/approver`
  `{ "device_id": string }` writes the next roster with that device a signer
  (keys and roles unchanged) and answers the status. It needs the desktop
  app's approval proof for `promote` on that device id (`X-Agentd-Approval`),
  like `devices/remove`; without it 403 `Let a device approve others in the
  OpenAgentd app on this computer.` An id that is not a device id is 400
  `Malformed request.`; other failures read as the signer routes' do (403 when
  this computer does not approve). A device not in the account, or one that
  left it though the roster still lists it, is 409 with an object detail:
  `{ "code": "device_not_in_account", "message": "That device is no longer
  in your account." }` (the web keys on `code`).
- **Status, summarized.** `signing_in` + `recovering` (bool, omitted when
  false), `connected` + `recovered` (bool, omitted when false), guest notice
  `wrong_recovery_code`. Remote callers still see only `state` and
  `fingerprint` of `signing_in`.

There is no schema change. `identity.json` gains `name_synced` (a string,
absent until set); older files read as before.

## Workspace `git` flag, and renamed labels and page names (v3.56.0)

`GET /api/agent/workspace/tree` adds `"git": true|false` to every repository
entry: whether the folder, or a parent of it, holds `.git`. The app offers
the Changes view and worktrees only where it is true, and treats a response
without the key (an older server) as before.

The provider catalog's label for `codex` is `ChatGPT` (it was `OpenAI
Codex`) and its description is reworded, in `GET /api/settings/providers`
and in the usage summary. Ids are unchanged.

Messages that point to a Settings page use the page's new name: `Settings →
Models` (it was Providers) in provider and image-tool errors and in `agentd
doctor`, `auth` and `run` hints, and `Settings → Connectors` (it was MCP) in
the `mcp` tool's answers. An `mcp` call refused for sign-in now reads
`needs sign-in: connect it in Settings → Connectors`; a stored row with the
earlier `Settings → MCP` wording still rides inline with its call
(`MCP_SIGN_IN_NOTE_BEFORE_RENAME`), and the web matches both. The error for
a turn with no model ends `Connect a model on the new-session screen or in
Settings → Models.` (it said `Connect a model provider`). No schema or
on-disk format change.

## Agent file fields, patch envelope and unloaded members (v3.56.0)

Agent frontmatter keys `mcp` and `responses_api` are ignored, whatever their
value: nothing read them. The `config` object in `/api/agents` responses no
longer includes either key, and the app stops writing them when it saves an
agent file from the form. A model's own `responses_api` setting is unchanged.

`patch` accepts an envelope without its closing `*** End Patch` line; a
missing `*** Begin Patch` line is still an error, and so is a last line that
puts the marker behind `+` or `-`. The envelope now ends at the last line
that starts with the marker, no longer at its last mention anywhere in the
text.

A member whose turn completed leaves the in-memory registry 5 minutes after
its report reached the lead. `GET /api/agent/sessions/{session_id}/subagents`
lists it as `completed`, as it already did for any member the registry does
not hold, and a message to its handle rebuilds it from its session row. A
member rebuilt this way announces `subagent_status` `completed`; one a
restart cut off still announces `stopped`. `team(action='list')` reads the
lead's child sessions as well as the registry. There is no schema or on-disk
format change.

## Scan to add (v3.55.0)

`POST /api/cloud/login` now also shows a QR code for a phone that approves
devices (tunnel spec 4.3.1). `GET /api/cloud/status` gains `add_link` on
`signing_in`, `scanned {fingerprint}`, and `confirming {fingerprint, choices}`.
`add_link` and `choices` are omitted for remote callers. Local-only
`POST /api/cloud/number {number}` accepts one answer; the identity is saved
and the connector starts only after the correct number. Cancel, a wrong
number, or the two-minute limit leaves the account and drops the keys, also
when the leave fails. `wrong_number` is a new guest notice. There is no
on-disk format change.

## MCP app panels (v3.55.0)

An MCP app's page is no longer part of its tool result. `extra.mcp_app` (the
tool row and `tool_end`'s `metadata.mcp_app`) carries `html_sha256` instead of
`html`; the page is written once to `<data_dir>/mcp-apps/<sha256>.html`. Rows
stored earlier keep their inline `html` and still render. There is no schema
change.

The panel's frame loads the page from the API, in an origin of its own:
`POST /api/mcp/app-frames {session_id, tool_call_id, head?}` returns
`{ticket}` for a stored app result, and `GET /api/mcp/app-frames/{ticket}`
serves the page once within 60 s, with `head` first in its `<head>`. That
`GET` needs no access key (the app can read its own address, so the address
must not hold one). It answers with its own `Content-Security-Policy`, built
from the resource's declared domains plus `sandbox allow-scripts allow-forms`,
and without `X-Frame-Options`.

`POST /api/mcp/app-context {session_id, tool_call_id, content?,
structuredContent?}` keeps what a panel reports for the model
(`ui/update-model-context`). The newest report of each panel is saved with the
session's next user message as a hidden `kind='note'` row
(`extra.mcp_app_context`). Until then a session's reports wait in
`<data_dir>/sessions/<id>/mcp-app-reports.json`, which outlives a restart and
is deleted with the session.

A stored page is deleted when no tool result names it: deleting a session
removes the pages only it named, and every start removes the rest. A page
written in the last 60 s is kept, since its result is saved after it.

The frame's origin has no storage, so the page gets a `localStorage` the
backend keeps: `POST /api/mcp/app-storage {session_id, tool_call_id, clear?,
remove?, set?}` applies an app's writes (in that order) to
`<data_dir>/mcp-apps/storage/<sha256 of the server name>.json`, 5 MB per MCP
server, and `GET /api/mcp/app-frames/{ticket}` hands the items to the page in
`window.__OA_APP_STORAGE__` before `head`. Deleting the server deletes them.

A Streamable HTTP server's session now outlives the process. The session id
and protocol version are written to `<state_dir>/mcp-sessions.json` (owner
only) when a session opens. The next start sends `tools/list` under the kept
session instead of `initialize`; a refusal (404 or any JSON-RPC error) opens a
new session, and a server that cannot be reached keeps its entry. Stopping
the process no longer sends the session `DELETE`; restarting, disabling or
removing one server, and reloading `mcp.json`, still do. `/api/mcp/app-tools/call`
waits up to 20 s for a server that is still `starting`.

A tool whose `_meta.ui.visibility` lacks `"model"` is left out of the agent's
tools, of `mcp` search and call, and of a server's `tool_names`.
`/api/mcp/app-tools/call` answers 403 for a tool whose visibility lacks
`"app"`.
