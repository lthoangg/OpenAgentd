# ADR-0005: Use a cache-backed Models.dev registry

## Status
Accepted

## Date
2026-07-15

## Context

Model metadata changes more frequently than application releases. A bundled
registry snapshot can be stale immediately after a user updates OpenAgentd,
and the runtime cache previously overrode a newly bundled snapshot based only
on its age. The registry is derived data: it can be downloaded again and does
not belong in user configuration or irreplaceable application state.

## Decision

OpenAgentd will source model metadata exclusively from the Models.dev cache at
`{OPENAGENTD_CACHE_DIR}/models-dev.json`, with an optional local YAML overlay.
The server refreshes the cache in the background at startup when it is older
than 24 hours; no registry snapshot is packaged with the application.

## Alternatives Considered

### Bundled snapshot plus runtime cache

- Pros: metadata is available on an offline first launch.
- Cons: application releases can package stale metadata, and cache-versus-
  bundle recency requires version-aware coordination.
- Rejected because: registry freshness is more important than offline metadata,
  and the cache is the authoritative derived source.

### Store registry metadata in configuration or state

- Pros: persists alongside user data.
- Cons: treats replaceable third-party data as user-managed configuration or
  irreplaceable state.
- Rejected because: the data is safe to delete and re-fetch.

## Consequences

- New models and pricing are available without a client release once the cache
  refresh succeeds.
- A first launch without a cache and without network access has no model
  metadata: capabilities and costs remain unknown until a fetch succeeds.
- Text chat remains available; conservative capability defaults continue to
  reject unsupported attachments and omit unavailable cost estimates.
- The runtime cache must remain under `OPENAGENTD_CACHE_DIR` and must not be
  committed or packaged.
