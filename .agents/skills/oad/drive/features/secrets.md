# Secrets

The agent asks for API keys by name with the `secret` tool. A card with a
masked field per key opens; each value goes to `PUT /api/secrets` and the
agent learns only the names. It then uses a key through the `shell` tool's
`secrets` argument, and any stored value in tool output reads `[secret NAME]`.

## Sub-features

- The card: "Needs you · secrets", the agent's reason, one masked field per
  key (Show / Hide), optional keys, the "New values are for" switch, Save and
  Decline. A key saved for another project offers "Use the one saved for …"
  or "Enter a different value", neither picked.
- The transcript summary after Save: "Provided: …", "Using saved: …",
  "Skipped: …".
- A `shell` call with `secrets` runs with the variable set; its output shows
  `[secret NAME]` where the value was.
- Settings → Secrets: one row per value with the projects that use it.

## How to get to it (user POV)

- The card opens above the composer (and "Answer below" in the transcript)
  when the agent asks. Settings → Secrets is under Work.

## Driving it with Playwright

- `drive:secret <JSON arguments>` makes the stub call `secret`, e.g.
  `{"action": "request", "reason": "…", "keys": [{"name": "K"}]}`.
- `drive:shell <JSON arguments>` passes them to `shell`, so a journey can set
  `secrets`.
- Each field is labelled `<NAME> value`. Use a key name unique to the run:
  a key an earlier run saved is usable already, and needs no card.
- Cross-check: `/api/secrets` (names only), the tool result from
  `/agent/<session>/tool-results/<id>`, and `modelRequests()` must never hold
  the value.

## Gotchas

- The card is pinned above the composer at both widths, so the transcript
  card only says "Answer below".
- Once the turn finishes, a phone (Simple detail) folds the answered card
  behind a "1 question" button; the "Provided: …" summary is inside it.
