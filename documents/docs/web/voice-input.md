---
title: Voice Input
description: Browser microphone flow, local speech-to-text config, and transcript insertion contract.
status: stable
updated: 2026-05-06
---

# Voice Input

Browser voice input records microphone audio, transcribes it on the backend,
and inserts the transcript into the existing chat input. It does **not** send
the message automatically.

## Scope

V1 is intentionally small:

- Web UI microphone input only.
- Local speech-to-text provider first.
- Manual recording stop: click the mic button to start, click again to stop.
- Transcript is inserted into the input field for review/editing.
- The user still presses Send manually.
- No TTS, voice replies, auto-send, streaming transcription, or silence auto-stop.

## Configuration

Voice input is controlled by the `voice` section in
`{OPENAGENTD_CONFIG_DIR}/speech.yaml`:

```yaml
voice:
  enabled: true
  model: local:base
  language: auto
  max_file_mb: 25
```

Rules:

- Missing `voice` section means voice input is disabled.
- `enabled: false` means voice input is disabled.
- `model` uses the existing `provider:name` shape. V1 supports `local:base`, `local:small`, and `local:medium`.
- `language: auto` lets the transcription backend detect the language.
- `max_file_mb` caps uploaded recording size before transcription.

Local transcription dependencies are optional. The base install must not import
or require `faster-whisper`. Users who enable `model: local:base` install the
extra explicitly:

```bash
uv sync --extra voice-local
```

For package/tool installs:

```bash
uv tool install "openagentd[voice-local]"
```

If local voice is configured without the extra, the backend returns a setup
error explaining that `openagentd[voice-local]` is required.

## Settings UI

Voice config is editable from **Settings → Voice** in the web UI. The page reads
the current config via `GET /api/speech/config` and writes changes via
`PUT /api/speech/config`. Changes are written to `speech.yaml` and hot-reloaded
immediately — no server restart needed.

## API Contract

| Method | Path | Returns |
|--------|------|---------|
| `GET` | `/api/speech/config` | `{enabled, model, language, max_file_mb}` — current voice config |
| `PUT` | `/api/speech/config` | `{enabled, model, language, max_file_mb}` — persist updated config |
| `POST` | `/api/speech/transcribe` | `{text}` — transcript for one uploaded recording |

`PUT /api/speech/config` accepts JSON with `enabled` (bool), `model`
(`"provider:name"`), `language` (string), `max_file_mb` (int > 0). Returns the
saved config.

`POST /api/speech/transcribe` accepts `multipart/form-data`:

| Field | Type | Notes |
|-------|------|-------|
| `file` | file | Browser `MediaRecorder` audio blob, expected to be `webm`/Opus in Chromium-based browsers. |

Expected errors:

- Voice disabled: mic button shown disabled with tooltip; direct `POST /transcribe` calls get a clear 503 error.
- Unsupported or oversized audio: request rejected before provider execution.
- Missing optional dependency for `local:*`: setup error with the `openagentd[voice-local]` install hint.
- Empty transcript: return `{text: ""}` so the UI can avoid modifying the input.

## Frontend Flow

The mic button lives beside Send in the chat input. When `voice.enabled` is
`false` the button is shown in a disabled state with a tooltip directing the
user to enable voice in Settings — it is not hidden.

| State | Behaviour |
|-------|-----------|
| Idle | Click requests microphone permission if needed, then starts recording. |
| Recording | Click stops recording and starts transcription. No silence auto-stop in V1. |
| Transcribing | Button shows loading state while the audio uploads. |
| Error | Toast the error and preserve any existing input text. |

When transcription succeeds, the transcript is inserted into the input. If the
input already has text, the transcript is appended with a separating space rather
than discarding the typed draft. Sending remains the existing typed-message path.

## Verification

- `voice.enabled: false` shows the mic button disabled with a tooltip; it does not send or record.
- Starting/stopping recording is controlled only by mic-button clicks.
- A successful transcription inserts text into the input and does not auto-send.
- Permission denial and transcription failure leave the existing input unchanged.
- Base backend startup works without `faster-whisper` installed.
- Configured local voice without the optional extra returns the documented setup error.
- `PUT /api/speech/config` with `enabled: true` is reflected immediately in the UI without a page reload.
