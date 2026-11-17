# Run picker

How the next message runs: the model, then that model's thinking level (and
its provider's accounts) on a page of its own.

## Sub-features

- Page 1: the model search and list, grouped by provider. A › marks a model
  with a page; a model without one (Ollama's stub) is picked in one step.
- Page 2: a "‹ model" back chip, the model's levels as rows (Default first
  while the model decides), then the provider's accounts when it has several.
- `/think` opens on the running model's page.
- No Reset to default or Make default.

## How to get to it (user POV)

- The model chip in the composer ("Model ollama:stub. Change") opens "Model
  and thinking": a popover on desktop, a bottom sheet on a phone.
- Desktop: type to search, Enter or → opens the model's page, ↑/↓ and Enter
  pick a level and close, ← or Backspace go back.
- Phone: tap a model, tap a level; the back chip goes back.

## Driving it with Playwright

- `drive.sh up` gives `anthropic:stub` the levels low, medium and high
  (`config/model_registry.yaml`), so its page has levels; `ollama:stub` has
  none.
- The level list is the listbox "Thinking for anthropic:stub"; the
  highlighted row carries `data-highlighted`.
- The chip's accessible name says the level: "Model anthropic:stub, thinking
  High. Change…".
- The model request the stub logs carries `thinking: {type: "enabled"}` once
  a level is picked.

## Gotchas

- `/think` is sent with the Send button; the picker then opens over the
  composer, and Escape closes it at both widths.
