# Image and video generation

`generate_image` and `generate_video` read `<CONFIG_DIR>/multimodal.yaml` on
every call. Write it when a tool returns "not configured", or when the user
asks. Pick the user's model, or default to:

```yaml
image:
  model: openai:gpt-image-2
video:
  model: googlegenai:veo-3.1-generate-preview
```

- Image providers: `openai`, `googlegenai`, `codex`. Video: `googlegenai` only.
- Use `model: <provider>:<name>`; a separate `provider:` key is rejected.
- Optional image extras (`size`, `quality`, `output_format` for OpenAI) — add
  only when asked.
- Write immediately — don't check for API keys first. If a key is missing the
  tool returns a clear error; relay it. Retry the original request after writing.
- The tools themselves must be enabled on the agent: add `generate_image` /
  `generate_video` to `code.md`'s `tools:` (see `agents.md`).

Changes take effect on the next `generate_image` / `generate_video` call.
