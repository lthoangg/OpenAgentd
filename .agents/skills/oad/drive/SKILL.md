---
name: oad/drive
description: Drive the real OpenAgentd app the way a user does and keep the proof — start a second, isolated instance with a scripted stand-in model, run user journeys in a browser at a phone width and a desktop width, and save screenshots and server state. Use after a UI or behavior change, before saying it works, and wherever a guide says to check a narrow and a wide layout.
---

Tests show the code is right. This shows the app is right: a real backend, the
real web UI, a real browser, at the two widths users have. It costs no model
calls and never touches your own sessions.

All commands run from the repository root.

## Launch

```bash
.agents/skills/oad/drive/scripts/drive.sh up
```

`up` builds the backend, then starts three processes and waits until each
answers:

| Process | Default | Change with |
|---|---|---|
| Model stub (`scripts/stub_model.py`) | `:8792` | `MODEL_PORT` |
| Backend (`agentd server serve`) | `:8791` | `API_PORT` |
| Web UI (Vite, serving your working tree) | `:5191` | `WEB_PORT` |

It is ready when it prints `ready: http://localhost:5191`. It starts from an
empty sandbox every time: `/tmp/oad-drive` (`DRIVE_DIR`) holds the server's
home, data, config and a small git repository, `code/demo`, for journeys to
change. The backend runs with a cleared environment, so no key, token, or
`OPENAGENTD_*` setting of yours reaches it, and it runs beside your own
`make dev` without sharing a port or a file. `up` refuses to start when a port
is taken or when `DRIVE_DIR` was not made by this script.

The only model is the stub. It answers over the three wire protocols the
backend speaks, so each provider's real request and stream code runs:

| Pick | Protocol | The reply starts with |
|---|---|---|
| `ollama:stub` (the default) | OpenAI Chat Completions | `Stub reply (chat):` |
| `ollama:stub` with a thinking level | OpenAI Responses | `Stub reply (responses):` |
| `anthropic:stub` | Anthropic Messages | `Stub reply (messages):` |

A prompt that contains `drive:shell <command>` makes the stub call the `shell`
tool with that command, and `drive:script <code>` makes it call the `script`
tool with that code; after the tool result it answers
`Stub (<protocol>): the tool finished.` A session is titled after its first
prompt. The stub's docstring is the full contract.

The web UI is Vite's dev server, so an edit under `web/src` shows without a
restart. After a Rust change, run `up` again.

## Doctor

```bash
.agents/skills/oad/drive/scripts/drive.sh doctor
```

Read-only. Run it first whenever something looks off. It checks that the
sandbox is this script's, that each of the three ports is held by the process
`up` started, that the backend is ready with every module running, that the
running backend is not older than the binary on disk, and that the web UI
serves. `run` calls it before driving. A `FAIL` line means: run `up` again.

## Drive

```bash
.agents/skills/oad/drive/scripts/drive.sh run                 # every journey, phone and desktop
.agents/skills/oad/drive/scripts/drive.sh run review terminal # only these
WIDTHS=phone .agents/skills/oad/drive/scripts/drive.sh run    # one width
```

A journey is one file in `scripts/journeys/`. It runs once per width in a
fresh browser profile: `phone` is 402×874 with touch, `desktop` is 1440×900.
The whole set takes about half a minute. The feature map in
[`features/`](features/README.md) says what each journey covers and how a user
reaches the same thing; read the feature's file before changing its journey.

Playwright comes from `scripts/readme-shots/` (installed there on first use).
It uses its own Chromium when that is installed and the system Chrome
otherwise.

To check your own change, add steps to the journey for that feature, or a new
journey file and a feature file beside the others. Write a step as a user
action followed by what the user then sees:

```js
await step("the reply streams in", async () => {
  await expect(page.getByText(`Stub reply (chat): ${text}`)).toBeVisible()
})
```

Rules for a journey:

- Reach things the way a user does: roles and accessible names, never CSS
  classes, coordinates, or store internals. `ctx.api` and `ctx.seedSession`
  are for preconditions and cross-checks only.
- Check the side effect as well as the screen: the row the server stored, the
  file on disk, the request the model received (`ctx.modelRequests()`).
- Put `ctx.run` in every prompt and file name, so a leftover from an earlier
  run cannot satisfy a check.
- A journey that cannot pass is a finding. Report it and write the reason in
  the feature's Gotchas. Never loosen it to make it pass.

`scripts/journeys.mjs` lists the helpers a journey receives (`step`, `send`,
`newSessionInDemo`, `openInReviewPanel`, `history`, `sessionId`, …).

## Evidence

Each `run` writes to `.openagentd/drive/<UTC time>/` (git-ignored):

- `<journey>-<width>-<n>-<step>.png`: the page after every step.
- `<…>.outline.txt`: for a failed step, the page's accessibility outline and
  address. Read this first; it usually names what was on screen instead.
- `report.json`: commit, whether the tree was dirty, and each journey's steps
  with pass or fail and the error.
- `model-requests.jsonl`: every request the app sent to the model.

`run` prints one `PASS` or `FAIL` line per journey and width and exits 1 when
any failed. Quote those lines and the evidence folder when you report.

## Cleanup

```bash
.agents/skills/oad/drive/scripts/drive.sh down
```

Stops the three processes `up` started, by their recorded process ids, never
by name. Evidence stays. The sandbox under `/tmp` stays until the next `up`
replaces it. Run `down` after a failed attempt too, so nothing holds a port.

## What this does not show

- The native shells. A browser at phone width is not the iOS or Android app:
  safe areas, the native keyboard, menus, the tray and the notch are outside
  it (see `oad/testing` → `references/native.md`).
- Visual regressions. Screenshots are saved, not compared; look at them.
- Real model behavior. The stub proves the app's handling of a turn, not what
  a model would write.
