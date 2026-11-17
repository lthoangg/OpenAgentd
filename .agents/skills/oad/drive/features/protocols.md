# Model protocols

The same turn, carried by each wire protocol the backend speaks. A provider
bug shows here as a reply that never arrives or a tool call that never runs.

## Sub-features

- Anthropic Messages (`anthropic:stub`): text, then a `shell` tool call.
- OpenAI Responses (`ollama:stub` with a thinking level): text, then a tool
  call.
- OpenAI Chat Completions is the default model and is covered by the
  `message` and `review` journeys.

## How to get to it (user POV)

- The model chip in the composer ("Model ollama:stub. Change") opens "Model
  and thinking": a popover on desktop, a bottom sheet on a phone. Models are
  grouped by provider.
- A thinking level is offered only for models known to have one. Picking a
  model with levels (the Anthropic stub) opens its levels page.

## Driving it with Playwright

- In the picker, option "stub" (exact) is the Anthropic model; Ollama's reads
  "stub default".
- The reply names the protocol: `Stub reply (messages): …`.
- `drive:shell echo x > file` in a prompt makes the stub call `shell`; the
  journey then reads the file from `ctx.demo`.
- `ctx.modelRequests()` shows which protocol carried each request.

## Gotchas

- Picking the Anthropic stub opens its levels page, which stays open over
  Send. The journey closes it with Escape; a user picks a level or taps
  outside it.
- The picker offers no thinking level for the Ollama stub, and a thinking
  level is what selects the Responses API. The journey therefore seeds the
  first turn through the API with `thinking_level=medium` and continues that
  session in the UI. Choosing a level in the picker is driven by
  `run-picker`.
- The model lists come from the stub: `drive.sh up` asks the backend to list
  each provider's models, as connecting a provider in Settings does.
