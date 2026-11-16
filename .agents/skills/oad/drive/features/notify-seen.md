# Seen on a screen

A notification the person sees on a screen does not also ring the account's
phone: a server holds each phone letter for a minute and drops it when a
client reported the session seen (`appv3/crates/api/src/cloud/letters.rs`).

## Sub-features

- Opening a session, or bringing its window back into focus, reports it seen.
- A Done or Needs you notification about the session on screen reports it
  seen at once, even moments after the session opened.
- Desktop only: opening or dismissing a notification in the pet or the
  notch island (Later on a question too) reports it seen from the shell
  (`desktop/src-tauri/src/answers.rs`, `report_seen`); a browser drive
  cannot show it, the desktop log says `seen: session=… reported`.

## How to get to it (user POV)

Nothing to click: keep a session on screen while its agent works. The phone
side needs an account and a real iPhone, which a drive cannot show.

## Driving it with Playwright

- The proof is the server's `session_seen session_id=<id>` log line, read from
  `$DRIVE_DIR/state/logs/app/app.log`: one when the session opens, one more
  when its turn's notification arrives.
- The page must have focus (`document.hasFocus()`); a headless page does.

## Gotchas

- The drive server signs in to no account, so no letter is ever sent; the
  end-to-end letter path is `appv3/crates/api/tests/cloud_e2e.rs`.
