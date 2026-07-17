# ADR-0007: Keep Grok Build OAuth separate from xAI API-key access

## Status
Accepted

## Date
2026-07-16

## Context

OpenAgentd already exposes `xai:` as a direct API-key provider against
`api.x.ai`. Grok Build uses a different authentication and inference contract:
OAuth device authorization with refresh tokens, followed by requests to the
Grok Build session proxy with provider-specific routing headers. Combining both
contracts under `xai:` would make the meaning of one saved provider depend on
which credential happened to be present and would prevent users from keeping
API-key billing and subscription access configured independently.

The provider prefix becomes part of agent configuration, saved session model
state, and the public API, so choosing that identity and credential ownership is
expensive to reverse.

## Decision

OpenAgentd exposes Grok Build subscription access as the distinct `grok:` OAuth
provider and retains `xai:` unchanged for direct API-key access. `grok:` uses
xAI's public Grok Build device flow, stores its refreshable credential in
OpenAgentd's private cache, and sends inference/model-discovery traffic only to
the fixed Grok Build session proxy with the required session and model-routing
headers. Billing reads use the same fixed proxy and OAuth session.

The OAuth request asks only for identity, offline refresh, Grok CLI, and API
access scopes. OpenAgentd does not request Grok conversation or workspace
read/write scopes because provider inference does not require them.

## Alternatives Considered

### Add OAuth as a second credential mode on `xai:`

- Pros: one provider prefix for every Grok model.
- Cons: ambiguous credential precedence, one Settings row for two billing and
  endpoint contracts, and no way to disconnect one mode independently.
- Rejected because: API-key and subscription access are separate provider
  contracts and should remain independently selectable.

### Read only the official Grok CLI's `~/.grok/auth.json`

- Pros: no additional login flow or credential file.
- Cons: requires a separately installed CLI, couples OpenAgentd to another
  application's evolving multi-scope storage schema, and prevents first-class
  Settings onboarding.
- Rejected because: OpenAgentd providers must be independently configurable and
  must own the credentials they refresh.

### Shell out to `grok login`

- Pros: delegates OAuth implementation to the official client.
- Cons: introduces an optional executable dependency, complicates mobile and
  packaged desktop behavior, and makes the Settings SSE login flow depend on
  parsing subprocess output.
- Rejected because: the standard device flow is small, documented, and works on
  every OpenAgentd surface without executing an external command.

## Consequences

- Users can configure `xai:` and `grok:` simultaneously and choose either model
  prefix per agent or session.
- Grok Build credentials are stored separately with owner-only permissions and
  refreshed through the fixed xAI issuer; secrets are never written to `.env`.
- The integration depends on xAI's public OAuth client, session-proxy headers,
  billing response, and proxy model catalog. Focused contract tests must flag
  upstream drift.
- Grok Build models inherit xAI model metadata without changing the existing
  Models.dev normalization of the `xai:` provider.
