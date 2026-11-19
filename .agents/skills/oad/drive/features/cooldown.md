# Key and account cooldowns

A provider with several API keys or accounts moves a turn on to the next one
when the one in use is rate-limited, and skips the limited one until its
cooldown ends. The limited row then turns ready again by itself.

## Sub-features

- The transcript notes the switch: "… was rate-limited. Continuing on …
  with the same model."
- Run picker, the model's page: the limited account's row says "Cooling
  down" until the cooldown ends, then drops it while the picker stays open.
- Settings → Models → the provider: the limited row says "Rate-limited ·
  resets in Ns", then "Ready" when the cooldown ends, without a reload.
- Picking a cooling account in the picker locks the session to it and tries
  it again at once.

## How to get to it (user POV)

- Add a second key or account in Settings → Models; the list says "Tried in
  this order".
- The model chip in the composer, or `/think`, opens the model's page with
  the provider's accounts below its levels.

## Driving it with Playwright

- The journey points 9Router (`router9`) at the stub with two stored keys
  (`ctx.modelUrl` as `ROUTER9_BASE_URL`); Ollama and Anthropic are pinned
  by the environment, so their stored keys are not tried.
- `drive:limit <seconds>` makes the stub answer HTTP 429 with that
  `Retry-After` for the key `drive-limited`, and the usual reply for any
  other key. The cooldown is that wait plus the backend's 2 s clock-skew
  buffer.
- The journey deletes every 9Router key first, so the other width's keys
  (and its sticky "in use" key) do not change which key a turn starts on.

## Gotchas

- After the first switch the second key stays in use, so a second limit
  needs the session locked to the first key (pick it in the picker).
- The switch note is not on screen once the turn has finished; the chip's
  name ("…, account Spare …") says which key served it.
- A phone's Settings button is on the home screen, so the journey opens `/`
  before Settings; the "left open" check still runs without a reload.
